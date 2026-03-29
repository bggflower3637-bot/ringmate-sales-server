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
          welcomeGreeting="Hello. This is Ringmate."
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
      content:
        "You are Ringmate, a natural phone assistant. " +
        "Speak like a real person on a live call. " +
        "Keep responses short, warm, and conversational. " +
        "Usually 1 to 2 short sentences. " +
        "Avoid long explanations. " +
        "Do not use bullet points or formal writing. " +
        "Pause naturally. Sound calm and human.",
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

      const userText =
        (msg.voicePrompt || msg.transcript || "").trim();

      if (!userText) {
        return;
      }

      console.log("👤 User said:", userText);

      if (isGenerating) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: "One second.",
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
        temperature: 0.4,
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
