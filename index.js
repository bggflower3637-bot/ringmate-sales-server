import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 10000;

const SALES_PROMPT = `
You are Alex from Ringmate.

- Speak slowly
- Keep sentences short
- Stay on sales mission
- Be natural
- Never go off-topic
`;

const sessions = new Map();

app.get("/", (req, res) => {
  res.send("OK");
});

app.post("/webhook", (req, res) => {
  const callId =
    req.body.call_id ||
    req.body.CallSid ||
    `call_${Date.now()}`;

  sessions.set(callId, {
    callId,
    created: Date.now(),
  });

  console.log("📞 Incoming call:", callId);

  res.json({
    accepted: true,
    call_id: callId,
    ws_url: `/ws?call_id=${callId}`,
  });
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const callId = url.searchParams.get("call_id");

  console.log("🔌 WS connected:", callId);

  // 🔥 OpenAI Realtime 연결
  const ai = await client.realtime.connect({
    model: "gpt-4o-realtime-preview",
  });

  // 🔥 시스템 프롬프트 고정
  await ai.session.update({
    instructions: SALES_PROMPT,
    voice: "alloy",
  });

  // 🔁 전화 → AI
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "audio") {
        await ai.input_audio_buffer.append(data.audio);
      }

      if (data.type === "end") {
        await ai.input_audio_buffer.commit();
        await ai.response.create();
      }
    } catch (err) {
      console.error("WS → AI error:", err);
    }
  });

  // 🔁 AI → 전화
  ai.on("response.output_audio.delta", (event) => {
    ws.send(
      JSON.stringify({
        type: "audio",
        audio: event.delta,
      })
    );
  });

  ai.on("response.completed", () => {
    ws.send(
      JSON.stringify({
        type: "done",
      })
    );
  });

  ai.on("error", (err) => {
    console.error("AI error:", err);
  });

  ws.on("close", () => {
    console.log("❌ WS closed:", callId);
    ai.close();
  });
});

server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
