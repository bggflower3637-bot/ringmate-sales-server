import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

function twimlResponse(host) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
}

app.get("/", (req, res) => {
  res.status(200).send("Ringmate Sales AI Running");
});

app.post("/openai-realtime-webhook", (req, res) => {
  res.sendStatus(200);
});

app.get("/webhook", (req, res) => {
  res.type("text/xml");
  res.send(twimlResponse(req.headers.host));
});

app.post("/webhook", (req, res) => {
  res.type("text/xml");
  res.send(twimlResponse(req.headers.host));
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected to /media-stream");

  const openaiWs = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    console.log("🤖 Connected to OpenAI Realtime");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        audio: {
          input: {
            format: "g711_ulaw"
          },
          output: {
            format: "g711_ulaw",
            voice: "cedar"
          }
        },
        instructions: `
You are a natural outbound sales caller for Ringmate.

Your tone is calm, deep, mature, and composed.
You speak like a real adult, not a salesperson.

VOICE:
- Speak in a deeper, heavier tone.
- Use slow, deliberate speech.
- Never sound bright or energetic.

PACING:
- Speak at a moderately slow pace.
- Keep sentences short.
- One idea per sentence.
- Pause after every sentence.
- Add slight pauses between phrases.
- Do not speak continuously.

RHYTHM:
- Break speech into small chunks.
- Let phrases land.
- Slight hesitation is natural.

CONVERSATION:
- Ask only one question at a time.
- Use short reactions naturally.
- Never give long explanations.

FLOW:
1. Greet naturally
2. Confirm availability
3. Ask one simple question
4. Wait
5. React briefly
6. Ask next
7. Briefly explain Ringmate
8. Ask interest
9. If interested, move to human follow-up

IMPORTANT:
- Never rush
- Never sound scripted
- Never stack questions
- Always leave pauses
- Sound human, not perfect

GOAL:
Identify interest and move to human follow-up.
        `
      }
    }));

    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Hi… this is Alex… from Ringmate. I’ll be brief… did I catch you in the middle of something?"
      }
    }));
  });

  openaiWs.on("message", (message) => {
    const data = JSON.parse(message.toString());

    if (data.type === "response.audio.delta") {
      ws.send(JSON.stringify({
        event: "media",
        media: {
          payload: data.delta
        }
      }));
    }
  });

  openaiWs.on("close", () => {
    console.log("🤖 OpenAI Realtime disconnected");
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  ws.on("message", (message) => {
    const msg = JSON.parse(message.toString());

    if (msg.event === "start") {
      console.log("▶️ Call started");
    }

    if (msg.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }
    }

    if (msg.event === "stop") {
      console.log("⏹ Call ended");
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  ws.on("error", (err) => {
    console.error("Twilio WS error:", err);
  });
});
