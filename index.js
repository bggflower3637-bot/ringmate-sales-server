import express from "express";
import WebSocket from "ws";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// OpenAI Realtime endpoint
const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// Twilio Webhook (SIP 연결)
app.post("/webhook", async (req, res) => {
  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// WebSocket server for Twilio Media Stream
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected");

  let openaiWs;

  // OpenAI Realtime 연결
  openaiWs = new WebSocket(REALTIME_URL, {
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    console.log("🤖 Connected to OpenAI Realtime");

    // 🎤 세션 설정 (최종 튜닝)
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
- Keep sentences short (max 8–10 words).
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
- Use short reactions: "Got it…", "Yeah… makes sense."
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
9. If interested → handoff to human

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

    // 🔥 첫 발화 강제 (리듬 적용됨)
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Hi… this is Alex… from Ringmate. I’ll be brief… did I catch you in the middle of something?"
      }
    }));
  });

  // OpenAI → Twilio (음성 전달)
  openaiWs.on("message", (message) => {
    const data = JSON.parse(message);

    if (data.type === "response.audio.delta") {
      ws.send(JSON.stringify({
        event: "media",
        media: {
          payload: data.delta
        }
      }));
    }
  });

  // Twilio → OpenAI (사용자 음성 전달)
  ws.on("message", (message) => {
    const msg = JSON.parse(message);

    if (msg.event === "media") {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }

    if (msg.event === "start") {
      console.log("▶️ Call started");
    }

    if (msg.event === "stop") {
      console.log("⏹ Call ended");
      openaiWs.close();
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio disconnected");
    if (openaiWs) openaiWs.close();
  });
});
