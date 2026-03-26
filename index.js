const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// 간단한 턴 저장 (임시)
const calls = new Map();

// ===============================
// 1️⃣ 첫 진입 (인사)
// ===============================
app.post("/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;

  calls.set(callSid, { turn: 0 });

  res.type("text/xml");
  res.send(`
    <Response>
      <Gather input="speech" action="/voice/process" method="POST">
        <Say>
          Hi, quick question. Are you currently handling your calls manually?
        </Say>
      </Gather>
    </Response>
  `);
});

// ===============================
// 2️⃣ 대화 처리
// ===============================
app.post("/voice/process", (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";

  const call = calls.get(callSid) || { turn: 0 };
  call.turn += 1;
  calls.set(callSid, call);

  console.log("User said:", userSpeech);

  let responseText = "";

  // 🔥 핵심: 턴 기반 흐름
  if (call.turn === 1) {
    responseText = "Got it, that makes sense. Do you ever miss calls when things get busy?";
  } else if (call.turn === 2) {
    responseText = "Yeah, that happens a lot. Would you be open to something that helps with that?";
  } else {
    responseText = "Got it, no worries. Have a great day!";
  }

  res.type("text/xml");
  res.send(`
    <Response>
      <Gather input="speech" action="/voice/process" method="POST">
        <Say>${responseText}</Say>
      </Gather>
    </Response>
  `);
});

// ===============================
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
