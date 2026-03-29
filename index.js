import express from "express";

const app = express();

// Twilio는 form-data로 보내기 때문에 필요
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * 기본 확인용 (브라우저 테스트)
 */
app.get("/", (req, res) => {
  res.send("Ringmate server running");
});

/**
 * 🔥 핵심: Twilio 전화 들어오는 엔드포인트
 */
app.post("/voice", (req, res) => {
  console.log("📞 Incoming call from Twilio");

  res.set("Content-Type", "text/xml");

  res.send(`
    <Response>
      <Say voice="alice">
        Hello. Ringmate realtime test is connected.
      </Say>
    </Response>
  `);
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
