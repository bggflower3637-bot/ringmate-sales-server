import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 10000;

// ------------------------
// Helpers
// ------------------------
function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${body}
</Response>`;
}

function gatherTwiml(message, action = "/voice/respond") {
  return twimlResponse(`
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST" language="en-US">
    <Say>${escapeXml(message)}</Say>
  </Gather>
  <Redirect method="POST">${action}</Redirect>
`);
}

function sayHangupTwiml(message) {
  return twimlResponse(`
  <Say>${escapeXml(message)}</Say>
  <Hangup/>
`);
}

function sayDialTwiml(message, number) {
  return twimlResponse(`
  <Say>${escapeXml(message)}</Say>
  <Dial>${escapeXml(number)}</Dial>
`);
}

function normalize(text = "") {
  return text.toLowerCase().trim();
}

function includesAny(text, patterns = []) {
  return patterns.some((p) => text.includes(p));
}

// ------------------------
// Simple in-memory session
// ------------------------
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      stage: "opening",
      transcript: [],
      questionAsked: false,
      secondQuestionAsked: false,
    });
  }
  return sessions.get(callSid);
}

function saveTurn(session, speaker, text) {
  session.transcript.push({
    speaker,
    text,
    at: new Date().toISOString(),
  });
}

// ------------------------
// Intent detection
// ------------------------
function detectIntent(text = "") {
  const t = normalize(text);

  if (
    includesAny(t, [
      "not interested",
      "no thanks",
      "stop calling",
      "remove me",
      "don't call",
      "do not call",
    ]) ||
    t === "no"
  ) {
    return "reject";
  }

  if (
    includesAny(t, [
      "busy",
      "call me later",
      "not a good time",
      "in a meeting",
      "can't talk",
      "cant talk",
      "later",
    ])
  ) {
    return "busy";
  }

  if (
    includesAny(t, [
      "what is this",
      "what's this",
      "what is this about",
      "what's this about",
      "why are you calling",
      "what do you want",
      "who is this",
    ])
  ) {
    return "why_calling";
  }

  if (
    includesAny(t, [
      "price",
      "pricing",
      "cost",
      "how much",
      "how does it work",
      "how do you work",
      "details",
      "can you explain",
      "tell me more about it",
    ])
  ) {
    return "deep_question";
  }

  if (
    includesAny(t, [
      "yes",
      "yeah",
      "sure",
      "okay",
      "ok",
      "maybe",
      "sounds good",
      "interested",
    ])
  ) {
    return "interest";
  }

  if (
    includesAny(t, [
      "i handle them myself",
      "we handle them ourselves",
      "manually",
      "myself",
      "ourselves",
    ])
  ) {
    return "self_handle";
  }

  return "general";
}

// ------------------------
// Script messages
// ------------------------
const MSG = {
  opening:
    "Hi — this is Ryan with Ringmate. We work with local businesses around call handling. Do you have a quick second?",

  firstQuestion:
    "Got it — appreciate it. Quick question — are you currently handling calls yourself right now?",

  secondQuestion:
    "Yeah — got it. Do you ever miss calls when things get busy?",

  whyCalling:
    "Yeah — absolutely. We help businesses catch missed calls and turn them into bookings. Just wanted to see if that’s something you might need.",

  handoff:
    "Got it — great question. This is probably easier if someone on our team walks you through it properly. Let me connect you real quick.",

  interestedHandoff:
    "Yeah — got it. Honestly, this is probably easier if someone on our team walks you through it properly. Let me connect you real quick.",

  reject:
    "No worries at all. If anything changes down the line, feel free to reach out. Appreciate your time — have a great day.",

  busy:
    "Got it — totally understand. We can follow up another time that works better for you.",

  fallback:
    "Yeah — got it. Quick question — are you currently handling calls yourself right now?",
};

// ------------------------
// Routes
// ------------------------
app.get("/", (_req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

// Twilio keeps calling this URL already
app.post("/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid || `call_${Date.now()}`;
  const session = getSession(callSid);

  session.stage = "permission";
  saveTurn(session, "assistant", MSG.opening);

  res.type("text/xml");
  res.send(gatherTwiml(MSG.opening, "/voice/respond"));
});

app.post("/voice/respond", async (req, res) => {
  try {
    const callSid = req.body.CallSid || `call_${Date.now()}`;
    const speechText = req.body.SpeechResult || "";
    const session = getSession(callSid);

    saveTurn(session, "user", speechText);

    const intent = detectIntent(speechText);
    const humanNumber = process.env.HUMAN_FORWARD_NUMBER || "+15555555555";

    // 1) hard exits
    if (intent === "reject") {
      saveTurn(session, "assistant", MSG.reject);
      res.type("text/xml");
      return res.send(sayHangupTwiml(MSG.reject));
    }

    if (intent === "busy") {
      saveTurn(session, "assistant", MSG.busy);
      res.type("text/xml");
      return res.send(sayHangupTwiml(MSG.busy));
    }

    // 2) direct handoff cases
    if (intent === "deep_question") {
      saveTurn(session, "assistant", MSG.handoff);
      res.type("text/xml");
      return res.send(sayDialTwiml(MSG.handoff, humanNumber));
    }

    if (intent === "interest" && session.questionAsked) {
      saveTurn(session, "assistant", MSG.interestedHandoff);
      res.type("text/xml");
      return res.send(sayDialTwiml(MSG.interestedHandoff, humanNumber));
    }

    // 3) "What is this about?"
    if (intent === "why_calling") {
      session.stage = "question_1";
      session.questionAsked = true;

      const message = `${MSG.whyCalling} ${MSG.firstQuestion}`;
      saveTurn(session, "assistant", message);

      res.type("text/xml");
      return res.send(gatherTwiml(message, "/voice/respond"));
    }

    // 4) stage flow
    if (session.stage === "permission") {
      session.stage = "question_1";
      session.questionAsked = true;

      saveTurn(session, "assistant", MSG.firstQuestion);

      res.type("text/xml");
      return res.send(gatherTwiml(MSG.firstQuestion, "/voice/respond"));
    }

    if (session.stage === "question_1") {
      session.stage = "question_2";
      session.secondQuestionAsked = true;

      saveTurn(session, "assistant", MSG.secondQuestion);

      res.type("text/xml");
      return res.send(gatherTwiml(MSG.secondQuestion, "/voice/respond"));
    }

    // After second question:
    // - 관심이면 handoff
    // - 애매하면 GPT 짧은 답변 후 다시 넘김 방향
    if (session.stage === "question_2") {
      if (intent === "interest" || intent === "self_handle") {
        saveTurn(session, "assistant", MSG.interestedHandoff);
        res.type("text/xml");
        return res.send(sayDialTwiml(MSG.interestedHandoff, humanNumber));
      }

      // 짧은 fallback GPT
      const aiReply = await generateShortReply(speechText);
      saveTurn(session, "assistant", aiReply);

      res.type("text/xml");
      return res.send(gatherTwiml(aiReply, "/voice/respond"));
    }

    // Fallback
    saveTurn(session, "assistant", MSG.fallback);
    res.type("text/xml");
    return res.send(gatherTwiml(MSG.fallback, "/voice/respond"));
  } catch (error) {
    console.error("Error in /voice/respond:", error);

    res.type("text/xml");
    return res.send(
      sayHangupTwiml("Sorry about that — we’ll follow up another time.")
    );
  }
});

// Optional debug
app.get("/debug/session/:callSid", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session);
});

// ------------------------
// GPT fallback
// ------------------------
async function generateShortReply(userText) {
  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
You are Ryan from Ringmate.
You are a calm, experienced male representative.

Rules:
- Keep replies very short.
- Sound natural and human.
- Do not explain deeply.
- Move the conversation toward either:
  1) a simple qualifying question, or
  2) handing off to a human.
- Max 2 short sentences.
          `.trim(),
        },
        {
          role: "user",
          content: `Customer said: "${userText}"
Write Ryan's next reply only.`,
        },
      ],
      max_output_tokens: 60,
    });

    const text = response.output_text?.trim();
    if (text) return text;

    return "Yeah — got it. Let me connect you real quick.";
  } catch (err) {
    console.error("OpenAI error:", err);
    return "Yeah — got it. Let me connect you real quick.";
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
