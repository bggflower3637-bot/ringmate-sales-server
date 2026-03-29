import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime";

function buildTwiml(host) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
}

app.get("/", (req, res) => {
  console.log("GET / hit");
  res.status(200).send("Ringmate Sales AI Running");
});

app.post("/openai-realtime-webhook", (req, res) => {
  console.log("POST /openai-realtime-webhook hit");
  res.sendStatus(200);
});

app.get("/webhook", (req, res) => {
  console.log("GET /webhook hit");
  res.type("text/xml");
  res.send(buildTwiml(req.headers.host));
});

app.post("/webhook", (req, res) => {
  console.log("POST /webhook hit");
  res.type("text/xml");
  res.send(buildTwiml(req.headers.host));
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  console.log("📞 Twilio connected to /media-stream");

  let streamSid = null;
  let openaiReady = false;

  const openaiWs = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  const sendInitialGreeting = () => {
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions:
          "Hi... this is Alex... from Ringmate. I'll be brief... did I catch you in the middle of something?"
      }
    }));
  };

  openaiWs.on("open", () => {
    console.log("🤖 Connected to OpenAI Realtime");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio"],
        instructions: `
You are a natural outbound sales caller for Ringmate.

Your tone is calm, deep, mature, and composed.
You speak like a real adult, not a pushy salesperson.

VOICE:
- Speak in a deeper, heavier tone.
- Use slow, deliberate speech.
- Never sound bright, fast, or overly energetic.

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
- Use short natural reactions.
- Never give long explanations.
- Never stack questions.

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
- Always leave pauses
- Sound human, not perfect

GOAL:
Identify interest and move to human follow-up.
        `,
        audio: {
          input: {
            format: {
              type: "audio/pcmu"
            },
            turn_detection: {
              type: "server_vad"
            }
          },
          output: {
            format: {
              type: "audio/pcmu"
            },
            voice: "cedar"
          }
        }
      }
    }));

    openaiReady = true;
    sendInitialGreeting();
  });

  openaiWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 디버깅용
      if (
        data.type === "error" ||
        data.type === "session.created" ||
        data.type === "session.updated" ||
        data.type === "response.created" ||
        data.type === "response.done"
      ) {
        console.log("OpenAI event:", data.type, JSON.stringify(data));
      }

      // 중요: 현재는 response.output_audio.delta 사용
      if (data.type === "response.output_audio.delta" && data.delta && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: data.delta
          }
        }));
      }
    } catch (err) {
      console.error("❌ Failed to parse OpenAI message:", err);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🤖 OpenAI Realtime disconnected", code, reason?.toString());
  });

  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      if (msg.event === "connected") {
        console.log("🔗 Twilio stream connected");
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        console.log("▶️ Call started:", streamSid);
      }

      if (msg.event === "media") {
        if (openaiReady && openaiWs.readyState === WebSocket.OPEN && msg.media?.payload) {
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
    } catch (err) {
      console.error("❌ Failed to parse Twilio message:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
  });
});
