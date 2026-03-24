const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// 서버 확인용
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Server Running");
});

// VAPI webhook (핵심)
app.post("/webhook/message", (req, res) => {
  console.log("Incoming webhook:", req.body);

  res.json({
    response: "Hey, just wanted to ask — how are you currently handling your calls and bookings?"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
