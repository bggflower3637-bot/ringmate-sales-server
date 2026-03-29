import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Ringmate server running");
});

// Twilio가 전화 들어오면 여기로 POST
app.post("/voice", (req, res) => {
  console.log("📞 Incoming call");

  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <ConversationRelay
          url="wss://ringmate-sales-server.onrender.com/ws"
          welcomeGreeting="Hello. This is Ringmate realtime test."
          interruptible="speech"
          language="en-US"
          ttsProvider="Google"
          voice="en-US-Standard-C">
        </ConversationRelay>
      </Connect>
    </Response>
  `);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  console.log("🔌 Twilio ConversationRelay connected");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("📩 From Twilio:", msg);

      // 첫 연결/시작 이벤트가 오면 테스트 응답 1회 보내기
      // 실제 이벤트 이름은 Twilio 로그에서 확인하면서 맞춰가면 된다.
      if (
        msg.type === "setup" ||
        msg.type === "connected" ||
        msg.type === "start"
      ) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Realtime connection is working."
          })
        );
      }

      // 사용자가 말한 텍스트가 오면 에코 테스트
      if (msg.type === "prompt" && msg.voicePrompt) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: `You said: ${msg.voicePrompt}`
          })
        );
      }

      // 일부 계정/설정에서는 transcript 필드로 올 수 있어서 같이 처리
      if (msg.type === "prompt" && msg.transcript) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: `You said: ${msg.transcript}`
          })
        );
      }
    } catch (err) {
      console.error("❌ WS parse error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio ConversationRelay disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err.message);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
