const express = require("express");
const cors = require("cors");

const app = express();

// 🔥 중요 (Twilio용)
app.use(express.urlencoded({ extended: false }));

// 기존용 (API 등)
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===============================
// ✅ Twilio Voice Webhook
// ===============================
app.post("/voice/incoming", (req, res) => {
  console.log("📞 Incoming call from Twilio");

  res.type("text/xml");
  res.send(`
    <Response>
      <Say>Hello, this is Ringmate Sales AI.</Say>
    </Response>
  `);
});

// ===============================
// (옵션) 기본 루트 확인용
// ===============================
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI server is running");
});

// ===============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
