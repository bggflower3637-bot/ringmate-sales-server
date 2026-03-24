const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// 간단한 상태 저장 (임시)
let conversations = {};

// 상태 정의
const STATES = {
  START: "start",
  QUALIFY: "qualify",
  PAIN: "pain",
  CLOSE: "close"
};

// 서버 확인
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

// 핵심 엔진
app.post("/webhook/message", (req, res) => {
  console.log("Incoming:", req.body);

  const userMessage = req.body.message || "";
  const callId = req.body.callId || "default";

  if (!conversations[callId]) {
    conversations[callId] = { state: STATES.START };
  }

  let state = conversations[callId].state;
  let response = "";

  // 🔥 FSM 로직
  if (state === STATES.START) {
    response = "Quick question — how are you currently handling incoming calls and bookings?";
    conversations[callId].state = STATES.QUALIFY;

  } else if (state === STATES.QUALIFY) {
    if (userMessage.toLowerCase().includes("manual")) {
      response = "Got it. Do you ever miss calls or feel overwhelmed during busy hours?";
      conversations[callId].state = STATES.PAIN;
    } else {
      response = "Got it. And roughly how many calls do you get per day?";
    }

  } else if (state === STATES.PAIN) {
    response = "That’s exactly where we help. We automate call handling so you never miss opportunities. Would you be open to a quick demo?";
    conversations[callId].state = STATES.CLOSE;

  } else {
    response = "No worries — I can follow up another time. Have a great day!";
  }

  res.json({ response });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
