const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

const calls = new Map();

// ===============================
// 1️⃣ 첫 진입
// ===============================
app.post("/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;

  calls.set(callSid, { turn: 0 });

  res.type("text/xml");
  res.send(`
    <Response>
      <Gather 
        input="speech"
        action="/voice/process"
        method="POST"
        speechTimeout="auto"
        timeout="2"
      >
        <Say>Hi—quick question. Do you handle calls yourself?</Say>
      </Gather>
      <Say>Sorry, I didn’t catch that.</Say>
      <Redirect>/voice/process</Redirect>
    </Response>
  `);
});

// ===============================
// 2️⃣ 대화 처리
// ===============================
app.post("/voice/process", (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";

  let call = calls.get(callSid);
  if (!call) call = { turn: 0 };

  call.turn += 1;
  calls.set(callSid, call);

  console.log("User said:", userSpeech);

  let responseText = "";

  // 🔥 짧고 자연스럽게
  if (call.turn === 1) {
    responseText = "Got it. Do you miss calls when it gets busy?";
  } else if (call.turn === 2) {
    responseText = "Yeah, that happens. Would that be helpful?";
  } else {
    responseText = "Got it. Have a great day!";
  }

  res.type("text/xml");
  res.send(`
    <Response>
      <Gather 
        input="speech"
        action="/voice/process"
        method="POST"
        speechTimeout="auto"
        timeout="2"
      >
        <Say>${responseText}</Say>
      </Gather>
      <Say>Sorry, I didn’t catch that.</Say>
      <Redirect>/voice/process</Redirect>
    </Response>
  `);
});

// ===============================
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI running");
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
