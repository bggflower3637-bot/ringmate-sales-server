import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || "";
const AUDIO_DIR = path.join(process.cwd(), "public", "audio");

fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use("/audio", express.static(AUDIO_DIR));

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */
const HUMAN_FORWARD_NUMBER =
  process.env.HUMAN_FORWARD_NUMBER || "+15555555555";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";

const ELEVENLABS_STABILITY = Number(
  process.env.ELEVENLABS_STABILITY || 0.55
);
const ELEVENLABS_SIMILARITY = Number(
  process.env.ELEVENLABS_SIMILARITY || 0.75
);
const ELEVENLABS_STYLE = Number(process.env.ELEVENLABS_STYLE || 0.04);

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

/* --------------------------------------------------
   MEMORY (replace with Redis/DB later if needed)
-------------------------------------------------- */
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      stage: "opening",
      transcript: [],
      questionCount: 0,
      handoffOffered: false,
      handoffConfirmed: false,
      callOutcome: null,
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

/* --------------------------------------------------
   HELPERS
-------------------------------------------------- */
function normalize(text = "") {
  return text.toLowerCase().trim();
}

function includesAny(text, arr = []) {
  return arr.some((item) => text.includes(item));
}

function hashText(text = "") {
  return crypto.createHash("md5").update(text).digest("hex");
}

function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${body}
</Response>`;
}

function twimlPlayAndGather(audioUrl, action = "/voice/respond") {
  return twiml(`
  <Play>${escapeXml(audioUrl)}</Play>
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST" language="en-US"/>
  <Redirect method="POST">${action}</Redirect>
`);
}

function twimlPlayAndHangup(audioUrl) {
  return twiml(`
  <Play>${escapeXml(audioUrl)}</Play>
  <Hangup/>
`);
}

function twimlPlayAndDial(audioUrl, number) {
  return twiml(`
  <Play>${escapeXml(audioUrl)}</Play>
  <Dial answerOnBridge="true">${escapeXml(number)}</Dial>
`);
}

function randomFiller() {
  const fillers = [
    "Yeah —",
    "Got it —",
    "Right —",
    "I hear you —",
    "Okay —",
  ];
  return fillers[Math.floor(Math.random() * fillers.length)];
}

/* --------------------------------------------------
   INTENT DETECTION
-------------------------------------------------- */
function detectIntent(text = "") {
  const t = normalize(text);

  if (
    includesAny(t, [
      "not interested",
      "no thanks",
      "remove me",
      "stop calling",
      "don't call",
      "do not call",
      "not now",
    ]) ||
    t === "no"
  ) {
    return "reject";
  }

  if (
    includesAny(t, [
      "busy",
      "call later",
      "not a good time",
      "can't talk",
      "cant talk",
      "in a meeting",
      "driving",
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
      "who is this",
      "what do you want",
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
      "tell me more",
      "can you explain",
      "what does it do",
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
      "sounds good",
      "interested",
      "maybe",
      "possibly",
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

  if (
    includesAny(t, [
      "connect me",
      "connect me now",
      "go ahead",
      "that's fine",
      "sure connect",
      "yes connect",
      "you can connect me",
    ])
  ) {
    return "confirm_connect";
  }

  if (
    includesAny(t, [
      "no don't connect",
      "not right now",
      "don't connect",
      "do not connect",
    ])
  ) {
    return "decline_connect";
  }

  return "general";
}

/* --------------------------------------------------
   SCRIPT
-------------------------------------------------- */
const MSG = {
  opening:
    "Hi — this is Ryan with Ringmate. Did I catch you at a bad time?",

  ifPermissionOkay:
    "Got it — I’ll be super quick. We work with local businesses around handling missed calls.",

  permissionIfBadTime:
    "No problem at all. We can always follow up another time that works better for you.",

  firstQuestion:
    "Quick question — are you currently handling calls yourself right now?",

  secondQuestion:
    "Yeah — got it. Do you ever miss calls when things get busy?",

  whyCalling:
    "Yeah — absolutely. We help businesses catch missed calls and turn them into bookings.",

  microValue:
    "That’s exactly the kind of thing we help with. We basically catch those missed calls and turn them into bookings.",

  offerHandoff:
    "Honestly — it’s probably easier if someone on our team walks you through it properly. Would you like me to connect you real quick?",

  confirmHandoff:
    "Perfect — give me one second.",

  declineHandoff:
    "No problem at all. If it makes more sense later, we can always follow up another time. Appreciate your time.",

  reject:
    "No worries at all. If anything changes down the line, feel free to reach out. Appreciate your time — have a great day.",

  busy:
    "Got it — totally understand. We can follow up another time that works better for you.",

  language:
    "No problem at all. We can follow up by text instead.",

  fallback:
    "Yeah — got it. Quick question — are you currently handling calls yourself right now?",
};

/* --------------------------------------------------
   ELEVENLABS TTS
-------------------------------------------------- */
async function synthesizeSpeech(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !BASE_URL) {
    throw new Error(
      "Missing ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, or BASE_URL"
    );
  }

  const fileName = `${hashText(text)}.mp3`;
  const filePath = path.join(AUDIO_DIR, fileName);
  const publicUrl = `${BASE_URL}/audio/${fileName}`;

  if (fs.existsSync(filePath)) {
    return publicUrl;
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: ELEVENLABS_STABILITY,
          similarity_boost: ELEVENLABS_SIMILARITY,
          style: ELEVENLABS_STYLE,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs error: ${response.status} ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

  return publicUrl;
}

/* --------------------------------------------------
   OPENAI SHORT FALLBACK
-------------------------------------------------- */
async function generateShortReply(userText, stage) {
  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: `
You are Ryan from Ringmate.
You are a calm, experienced male caller.

Your role:
- sound human
- keep replies short
- never dump information
- never hard sell
- move toward either:
  1) a short qualifying question
  2) a handoff offer
  3) a polite exit

Rules:
- max 2 short sentences
- natural spoken English
- slightly warm, confident, calm
- do not sound robotic
- do not say too much at once

Current stage: ${stage}
          `.trim(),
        },
        {
          role: "user",
          content: `Customer said: "${userText}"
Write Ryan's next spoken reply only.`,
        },
      ],
      max_output_tokens: 60,
    });

    return (
      response.output_text?.trim() ||
      `${randomFiller()} ${MSG.offerHandoff}`
    );
  } catch (error) {
    console.error("OpenAI error:", error);
    return `${randomFiller()} ${MSG.offerHandoff}`;
  }
}

/* --------------------------------------------------
   ROUTES
-------------------------------------------------- */
app.get("/", (_req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

app.post("/voice/incoming", async (req, res) => {
  try {
    const callSid = req.body.CallSid || `call_${Date.now()}`;
    const session = getSession(callSid);

    session.stage = "permission";
    saveTurn(session, "assistant", MSG.opening);

    const audioUrl = await synthesizeSpeech(MSG.opening);

    res.type("text/xml");
    return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
  } catch (error) {
    console.error("/voice/incoming error:", error);
    res.type("text/xml");
    return res.send(
      twiml(`
  <Say>Sorry, something went wrong.</Say>
  <Hangup/>
`)
    );
  }
});

app.post("/voice/respond", async (req, res) => {
  try {
    const callSid = req.body.CallSid || `call_${Date.now()}`;
    const speechText = req.body.SpeechResult || "";
    const session = getSession(callSid);
    const intent = detectIntent(speechText);

    saveTurn(session, "user", speechText);

    // -------- hard exits
    if (intent === "reject") {
      session.callOutcome = "rejected";
      saveTurn(session, "assistant", MSG.reject);
      const audioUrl = await synthesizeSpeech(MSG.reject);

      res.type("text/xml");
      return res.send(twimlPlayAndHangup(audioUrl));
    }

    if (intent === "busy" && session.stage !== "handoff_permission") {
      session.callOutcome = "follow_up";
      saveTurn(session, "assistant", MSG.busy);
      const audioUrl = await synthesizeSpeech(MSG.busy);

      res.type("text/xml");
      return res.send(twimlPlayAndHangup(audioUrl));
    }

    // -------- stage: permission
    if (session.stage === "permission") {
      // If they ask what this is about immediately
      if (intent === "why_calling") {
        const message = `${MSG.whyCalling} ${MSG.firstQuestion}`;
        session.stage = "question_1";
        session.questionCount = 1;

        saveTurn(session, "assistant", message);
        const audioUrl = await synthesizeSpeech(message);

        res.type("text/xml");
        return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
      }

      // If they say it's okay / not bad time / yeah
      if (intent === "interest" || intent === "general") {
        const message = `${MSG.ifPermissionOkay} ${MSG.firstQuestion}`;
        session.stage = "question_1";
        session.questionCount = 1;

        saveTurn(session, "assistant", message);
        const audioUrl = await synthesizeSpeech(message);

        res.type("text/xml");
        return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
      }

      // fallback
      const message = `${MSG.ifPermissionOkay} ${MSG.firstQuestion}`;
      session.stage = "question_1";
      session.questionCount = 1;

      saveTurn(session, "assistant", message);
      const audioUrl = await synthesizeSpeech(message);

      res.type("text/xml");
      return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
    }

    // -------- stage: question_1
    if (session.stage === "question_1") {
      // If they ask detail too early, don't dump info; offer human
      if (intent === "deep_question") {
        session.stage = "handoff_permission";
        session.handoffOffered = true;

        saveTurn(session, "assistant", MSG.offerHandoff);
        const audioUrl = await synthesizeSpeech(MSG.offerHandoff);

        res.type("text/xml");
        return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
      }

      // Normal flow
      session.stage = "question_2";
      session.questionCount = 2;

      saveTurn(session, "assistant", MSG.secondQuestion);
      const audioUrl = await synthesizeSpeech(MSG.secondQuestion);

      res.type("text/xml");
      return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
    }

    // -------- stage: question_2
    if (session.stage === "question_2") {
      // Strong signal: they handle calls themselves OR interest
      if (
        intent === "self_handle" ||
        intent === "interest" ||
        intent === "deep_question"
      ) {
        const message = `${MSG.microValue} ${MSG.offerHandoff}`;
        session.stage = "handoff_permission";
        session.handoffOffered = true;

        saveTurn(session, "assistant", message);
        const audioUrl = await synthesizeSpeech(message);

        res.type("text/xml");
        return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
      }

      // If uncertain, use very short AI reply then still move toward offer
      const aiReply = await generateShortReply(speechText, session.stage);
      session.stage = "handoff_permission";
      session.handoffOffered = true;

      saveTurn(session, "assistant", aiReply);
      const audioUrl = await synthesizeSpeech(aiReply);

      res.type("text/xml");
      return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
    }

    // -------- stage: handoff_permission
    if (session.stage === "handoff_permission") {
      if (intent === "confirm_connect" || intent === "interest") {
        session.stage = "handoff_execute";
        session.handoffConfirmed = true;
        session.callOutcome = "transferred";

        saveTurn(session, "assistant", MSG.confirmHandoff);
        const audioUrl = await synthesizeSpeech(MSG.confirmHandoff);

        res.type("text/xml");
        return res.send(twimlPlayAndDial(audioUrl, HUMAN_FORWARD_NUMBER));
      }

      if (intent === "decline_connect" || intent === "busy") {
        session.callOutcome = "deferred";
        saveTurn(session, "assistant", MSG.declineHandoff);
        const audioUrl = await synthesizeSpeech(MSG.declineHandoff);

        res.type("text/xml");
        return res.send(twimlPlayAndHangup(audioUrl));
      }

      // Ask once more, gently
      const reprompt =
        "No pressure at all — would you like me to connect you with someone real quick, or would later be better?";
      saveTurn(session, "assistant", reprompt);
      const audioUrl = await synthesizeSpeech(reprompt);

      res.type("text/xml");
      return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
    }

    // -------- fallback
    saveTurn(session, "assistant", MSG.fallback);
    const audioUrl = await synthesizeSpeech(MSG.fallback);

    res.type("text/xml");
    return res.send(twimlPlayAndGather(audioUrl, "/voice/respond"));
  } catch (error) {
    console.error("/voice/respond error:", error);

    res.type("text/xml");
    return res.send(
      twiml(`
  <Say>Sorry about that. We’ll follow up another time.</Say>
  <Hangup/>
`)
    );
  }
});

app.get("/debug/session/:callSid", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
