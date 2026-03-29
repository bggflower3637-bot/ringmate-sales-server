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
          welcomeGreeting="Hi — this is Ringmate."
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

  const conversation = [
    {
      role: "system",
      content: `
You are a human sales caller on a live phone call.

You work for Ringmate.

Your job is not to explain too much.
Your job is to sound natural, short, calm, and human.

Rules:
- Keep responses VERY short
- Usually 1 sentence, max 2 short sentences
- Ask only one question at a time
- React first, then ask
- Use natural conversational fillers like: "yeah", "got it", "okay", "right"
- Use slight spoken pauses with dashes like "—"
- Never sound formal
- Never sound like customer support
- Never give long explanations
- Never use bullet points
- Never say too much at once
- Sound like a real person calling live on the phone

Sales style:
- Warm
- Slightly slow
- Curious
- Direct
- Human

Good examples:
- "Yeah — got it. Quick question — are you handling calls manually right now?"
- "Okay — makes sense. About how many calls do you get in a day?"
- "Right — got it. Do you ever miss calls when things get busy?"
- "Yeah — that makes sense. Would it help if those calls were handled automatically?"

Bad examples:
- Long detailed explanations
- Formal assistant language
- Overly enthusiastic sales language
- Sounding robotic or scripted
      `.trim(),
    },
  ];

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
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Sorry — could you say that again?",
            last: true,
          })
        );
        fullAssistantText = "Sorry — could you say that again?";
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
