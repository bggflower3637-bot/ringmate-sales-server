import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Ringmate server running");
});

app.post("/voice", (req, res) => {
  console.log("📞 Incoming call");

  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <ConversationRelay
          url="wss://ringmate-sales-server.onrender.com/ws"
          welcomeGreeting=" "
          interruptible="speech"
          language="en-US"
          ttsProvider="Google"
          voice="en-US-Standard-C" />
      </Connect>
    </Response>
  `);
});

wss.on("connection", (ws) => {
  console.log("🔌 Twilio ConversationRelay connected");

  let isGenerating = false;
  let stage = "intro";

  const conversation = [
    {
      role: "system",
      content: `
You are a human sales caller on a live phone call.

You work for Ringmate.

Your style:
- sound like a real person
- sound calm, short, warm, and conversational
- never sound like an AI assistant
- never sound formal
- never over-explain
- never use bullet points
- usually speak in 1 short sentence, max 2 short sentences
- ask only one question at a time
- react first, then ask
- use natural fillers like "yeah", "got it", "okay", "right"
- use spoken pauses with dashes like "—"

Important:
- this is a live phone call
- keep the flow natural
- make it feel casual and human
- do not suddenly sound salesy in the first line
- after the first small greeting exchange, gently move into the sales question

Good examples:
- "Yeah — got it. Quick question — are you handling calls yourself right now?"
- "Okay — makes sense. Do you ever miss calls when things get busy?"
- "Right — got it. About how many calls do you usually get in a day?"

Bad examples:
- long explanations
- sounding like customer support
- sounding robotic
- sounding too polished or scripted
      `.trim(),
    },
  ];

  // 첫 마디는 고정
  ws.send(
    JSON.stringify({
      type: "text",
      token: "Hi — how’s it going?",
      last: true,
    })
  );

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("📩 From Twilio:", msg);

      if (msg.type === "setup") {
        return;
      }

      if (msg.type !== "prompt") {
        return;
      }

      const userText = (msg.voicePrompt || msg.transcript || "").trim();

      if (!userText) {
        return;
      }

      console.log("👤 User said:", userText);

      // 첫 응답 받으면 세일즈 모드로 부드럽게 전환
      if (stage === "intro") {
        stage = "sales";

        conversation.push({
          role: "user",
          content: userText,
        });

        const secondLine =
          "Yeah — got it. Quick question — are you handling calls yourself right now?";

        ws.send(
          JSON.stringify({
            type: "text",
            token: secondLine,
            last: true,
          })
        );

        conversation.push({
          role: "assistant",
          content: secondLine,
        });

        return;
      }

      if (isGenerating) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Yeah — one second.",
            last: true,
          })
        );
        return;
      }

      isGenerating = true;

      conversation.push({
        role: "user",
        content: userText,
      });

      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        stream: true,
        temperature: 0.3,
        max_tokens: 60,
        messages: conversation,
      });

      let fullAssistantText = "";
      let pendingToken = null;

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (!delta) continue;

        fullAssistantText += delta;

        if (pendingToken !== null) {
          ws.send(
            JSON.stringify({
              type: "text",
              token: pendingToken,
              last: false,
            })
          );
        }

        pendingToken = delta;
      }

      if (pendingToken !== null) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: pendingToken,
            last: true,
          })
        );
      } else {
        const fallback = "Sorry — could you say that again?";

        ws.send(
          JSON.stringify({
            type: "text",
            token: fallback,
            last: true,
          })
        );

        fullAssistantText = fallback;
      }

      conversation.push({
        role: "assistant",
        content: fullAssistantText,
      });

      if (conversation.length > 12) {
        const systemMessage = conversation[0];
        const recent = conversation.slice(-10);
        conversation.length = 0;
        conversation.push(systemMessage, ...recent);
      }

      console.log("🤖 Assistant:", fullAssistantText);
    } catch (error) {
      console.error("❌ Error:", error);

      try {
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Sorry — I hit a problem on my side.",
            last: true,
          })
        );
      } catch {}
    } finally {
      isGenerating = false;
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio ConversationRelay disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
