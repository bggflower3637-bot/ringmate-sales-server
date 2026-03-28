import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://your-render-service.onrender.com";

// --------------------------------------------------
// In-memory session store
// Replace with Redis / DB in production
// --------------------------------------------------
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      stage: "opening",
      questionCount: 0,
      lastIntent: null,
      interestLevel: null,
      result: null,
      transcript: []
    });
  }
  return sessions.get(callSid);
}

function saveTurn(session, speaker, text) {
  session.transcript.push({ speaker, text, at: new Date().toISOString() });
}

function normalize(text = "") {
  return text.toLowerCase().trim();
}

function detectIntent(text = "") {
  const t = normalize(text);

  const deepQuestionPatterns = [
    /how much/,
    /price/,
    /pricing/,
    /cost/,
    /how does it work/,
    /how do(es)? this work/,
    /details/,
    /what exactly/,
    /can you explain/
  ];

  const interestPatterns = [
    /yes/,
    /yeah/,
    /maybe/,
    /sounds good/,
    /okay/,
    /ok/,
    /interested/,
    /tell me more/
  ];

  const rejectPatterns = [
    /not interested/,
    /nope/,
    /^no$/,
    /stop calling/,
    /remove me/,
    /don'?t call/,
    /not now/
  ];

  const busyPatterns = [
    /busy/,
    /call me later/,
    /not a good time/,
    /in a meeting/,
    /can't talk/,
    /cant talk/
  ];

  const whyPatterns = [
    /what is this about/,
    /what'?s this about/,
    /why are you calling/,
    /what do you want/,
    /who is this/
  ];

  const languagePatterns = [
    /i don't speak english/,
    /no english/,
    /english is not good/
  ];

  if (languagePatterns.some((r) => r.test(t))) return "language";
  if (busyPatterns.some((r) => r.test(t))) return "busy";
  if (rejectPatterns.some((r) => r.test(t))) return "reject";
  if (deepQuestionPatterns.some((r) => r.test(t))) return "deep_question";
  if (whyPatterns.some((r) => r.test(t))) return "why_calling";
  if (interestPatterns.some((r) => r.test(t))) return "interest";

  return "general";
}

function filler() {
  const list = ["Yeah—", "Got it—", "Right—", "I see—", "Hmm—"];
  return list[Math.floor(Math.random() * list.length)];
}

function twimlSayAndGather({ message, action = "/voice/respond", voice = "Polly.Joanna" }) {
  // Twilio <Gather input="speech"> pattern
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST" language="en-US">
    <Say voice="${voice}">${escapeXml(message)}</Say>
  </Gather>
  <Redirect method="POST">/voice/respond</Redirect>
</Response>`;
}

function twimlSayAndHangup({ message, voice = "Polly.Joanna" }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

function twimlConnectHuman({ phoneNumber }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">One quick second — I’ll connect you now.</Say>
  <Dial>${escapeXml(phoneNumber)}</Dial>
</Response>`;
}

function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function generateShortReply({ userText, session }) {
  const system = `
You are Ryan from Ringmate.
You are a calm, confident, experienced male sales rep.

Your job:
- sound natural and human
- keep replies short
- create curiosity
- never deeply explain
- if the user is interested or asks detailed questions, move toward handoff

Rules:
- Always start naturally, like a real person.
- Keep it to 1 or 2 short sentences.
- No long explanations.
- No pushy tone.
- If the conversation is unclear, respond briefly and move back toward either:
  1) a simple qualifying question, or
  2) a polite handoff.

Context:
- Ringmate helps businesses catch missed calls and turn them into bookings.
- This is a cold outbound call.
- The caller should sound polite, calm, and not robotic.
- The conversation should feel like a human talking, not a script being read.

Current stage: ${session.stage}
Question count so far: ${session.questionCount}
`;

  const user = `Customer said: "${userText}"

Write Ryan's next reply only.`;

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_output_tokens: 80
  });

  return (response.output_text || `${filler()} got it.`).trim();
}

function openingMessage() {
  return [
    "Hi — this is Ryan with Ringmate.",
    "We work with local businesses around call handling.",
    "Do you have a quick second?"
  ].join(" ");
}

function firstQuestionMessage() {
  return [
    "Got it — appreciate it.",
    "Quick question — are you currently handling calls yourself right now?"
  ].join(" ");
}

function secondQuestionMessage() {
  return [
    `${filler()} got it.`,
    "Do you ever miss calls when things get busy?"
  ].join(" ");
}

function whyCallingMessage() {
  return [
    "Yeah — absolutely.",
    "We help businesses catch missed calls and turn them into bookings.",
    "Just wanted to see if that’s something you might need."
  ].join(" ");
}

function handoffMessage() {
  return [
    `${filler()} great question.`,
    "This is probably easier if someone on our team walks you through it properly.",
    "Let me connect you real quick."
  ].join(" ");
}

function followUpMessage() {
  return [
    "Got it — totally understand.",
    "We can follow up another time that works better for you."
  ].join(" ");
}

function rejectMessage() {
  return [
    "No worries at all.",
    "If anything changes down the line, feel free to reach out.",
    "Appreciate your time — have a great day."
  ].join(" ");
}

function languageMessage() {
  return [
    "No problem at all.",
    "We can follow up by text instead."
  ].join(" ");
}

// --------------------------------------------------
// 1) Incoming call entrypoint
// --------------------------------------------------
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;
  const session = getSession(callSid);

  session.stage = "permission";
  saveTurn(session, "assistant", openingMessage());

  res.type("text/xml").send(
    twimlSayAndGather({
      message: openingMessage(),
      action: "/voice/respond"
    })
  );
});

// --------------------------------------------------
// 2) Speech response handler
// --------------------------------------------------
app.post("/voice/respond", async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const speechText = req.body.SpeechResult || "";
    const session = getSession(callSid);

    saveTurn(session, "user", speechText);

    const intent = detectIntent(speechText);
    session.lastIntent = intent;

    // Stage-driven handling
    if (intent === "reject") {
      session.result = "rejected";
      saveTurn(session, "assistant", rejectMessage());
      return res.type("text/xml").send(twimlSayAndHangup({ message: rejectMessage() }));
    }

    if (intent === "busy") {
      session.result = "follow_up";
      saveTurn(session, "assistant", followUpMessage());
      return res.type("text/xml").send(twimlSayAndHangup({ message: followUpMessage() }));
    }

    if (intent === "language") {
      session.result = "follow_up_text";
      saveTurn(session, "assistant", languageMessage());
      return res.type("text/xml").send(twimlSayAndHangup({ message: languageMessage() }));
    }

    if (intent === "deep_question") {
      session.result = "transferred";
      saveTurn(session, "assistant", handoffMessage());
      return res.type("text/xml").send(twimlConnectHuman({ phoneNumber: process.env.HUMAN_FORWARD_NUMBER || "+15555555555" }));
    }

    if (intent === "interest") {
      session.interestLevel = "yes_or_maybe";
      session.result = "transferred";
      saveTurn(session, "assistant", handoffMessage());
      return res.type("text/xml").send(twimlConnectHuman({ phoneNumber: process.env.HUMAN_FORWARD_NUMBER || "+15555555555" }));
    }

    if (intent === "why_calling") {
      session.stage = "explained_reason";
      session.questionCount += 1;
      const msg = `${whyCallingMessage()} ${firstQuestionMessage()}`;
      saveTurn(session, "assistant", msg);
      return res.type("text/xml").send(
        twimlSayAndGather({ message: msg, action: "/voice/respond" })
      );
    }

    // Stage-based default flow
    if (session.stage === "permission") {
      session.stage = "question_1";
      session.questionCount += 1;
      saveTurn(session, "assistant", firstQuestionMessage());
      return res.type("text/xml").send(
        twimlSayAndGather({ message: firstQuestionMessage(), action: "/voice/respond" })
      );
    }

    if (session.stage === "question_1") {
      session.stage = "question_2";
      session.questionCount += 1;
      saveTurn(session, "assistant", secondQuestionMessage());
      return res.type("text/xml").send(
        twimlSayAndGather({ message: secondQuestionMessage(), action: "/voice/respond" })
      );
    }

    if (session.stage === "question_2") {
      // After second question, any continued engagement gets handed off or gently ended.
      const msg = await generateShortReply({ userText: speechText, session });
      saveTurn(session, "assistant", msg);

      return res.type("text/xml").send(
        twimlSayAndGather({ message: msg, action: "/voice/respond" })
      );
    }

    // Fallback
    const fallback = await generateShortReply({ userText: speechText, session });
    saveTurn(session, "assistant", fallback);

    return res.type("text/xml").send(
      twimlSayAndGather({ message: fallback, action: "/voice/respond" })
    );
  } catch (error) {
    console.error("/voice/respond error:", error);
    return res.type("text/xml").send(
      twimlSayAndHangup({
        message: "Sorry about that — we’ll follow up another time."
      })
    );
  }
});

// --------------------------------------------------
// 3) Optional: inspect session logs
// --------------------------------------------------
app.get("/debug/session/:callSid", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.get("/", (_req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
