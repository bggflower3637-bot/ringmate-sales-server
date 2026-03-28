import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || "";
const AUDIO_DIR = path.join(process.cwd(), "public", "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use("/audio", express.static(AUDIO_DIR));

const HUMAN_FORWARD_NUMBER = process.env.HUMAN_FORWARD_NUMBER || "+15555555555";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const ELEVENLABS_STABILITY = Number(process.env.ELEVENLABS_STABILITY || 0.72);
const ELEVENLABS_SIMILARITY = Number(process.env.ELEVENLABS_SIMILARITY || 0.8);
const ELEVENLABS_STYLE = Number(process.env.ELEVENLABS_STYLE || 0.03);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

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
      reactionStyle: "neutral"
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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

function twimlPlaySequenceAndGather(audioUrls, action = "/voice/respond") {
  const plays = audioUrls.map((url) => `  <Play>${escapeXml(url)}</Play>`).join("\n");
  return twiml(`
${plays}
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST" language="en-US"/>
  <Redirect method="POST">${action}</Redirect>
`);
}

function twimlPlaySequenceAndHangup(audioUrls) {
  const plays = audioUrls.map((url) => `  <Play>${escapeXml(url)}</Play>`).join("\n");
  return twiml(`
${plays}
  <Hangup/>
`);
}

function twimlPlaySequenceAndDial(audioUrls, number) {
  const plays = audioUrls.map((url) => `  <Play>${escapeXml(url)}</Play>`).join("\n");
  return twiml(`
${plays}
  <Dial answerOnBridge="true">${escapeXml(number)}</Dial>
`);
}

function pauseText() {
  return "...";
}

function getFiller(style = "neutral") {
  const pool = {
    short: ["Got it...", "Yeah...", "Right..."],
    positive: ["Yeah...", "That makes sense...", "Right..."],
    engaged: ["Yeah...", "I hear you...", "Exactly..."],
    neutral: ["Got it...", "Yeah...", "I see..."]
  };
  const arr = pool[style] || pool.neutral;
  return arr[Math.floor(Math.random() * arr.length)];
}

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
      "not now"
    ]) || t === "no"
  ) return "reject";

  if (
    includesAny(t, [
      "busy",
      "call later",
      "not a good time",
      "can't talk",
      "cant talk",
      "in a meeting",
      "driving",
      "later"
    ])
  ) return "busy";

  if (
    includesAny(t, [
      "what is this",
      "what's this",
      "what is this about",
      "what's this about",
      "why are you calling",
      "who is this",
      "what do you want"
    ])
  ) return "why_calling";

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
      "what does it do"
    ])
  ) return "deep_question";

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
      "possibly"
    ])
  ) return "interest";

  if (
    includesAny(t, [
      "i handle them myself",
      "we handle them ourselves",
      "manually",
      "myself",
      "ourselves"
    ])
  ) return "self_handle";

  if (
    includesAny(t, [
      "connect me",
      "go ahead",
      "that's fine",
      "sure connect",
      "yes connect",
      "you can connect me"
    ])
  ) return "confirm_connect";

  if (
    includesAny(t, [
      "don't connect",
      "do not connect",
      "not right now"
    ])
  ) return "decline_connect";

  return "general";
}

function detectReactionStyle(text = "") {
  const t = normalize(text);
  const wordCount = t.split(/\s+/).filter(Boolean).length;

  if (wordCount <= 2) return "short";
  if (includesAny(t, ["yeah", "yes", "sure", "okay", "ok"])) return "positive";
  if (includesAny(t, ["we do", "sometimes", "a lot", "that's true", "exactly"])) return "engaged";
  return "neutral";
}

const MSG = {
  openingParts: [
    "Hi... this is Ryan... with Ringmate.",
    "Did I catch you at a bad time?"
  ],
  permissionOkayParts: [
    "Got it... I'll be quick.",
    "We work with local businesses... around handling missed calls.",
    "Quick question... are you currently handling calls yourself right now?"
  ],
  whyCallingParts: [
    "Yeah... absolutely.",
    "We help businesses... catch missed calls... and turn them into bookings.",
    "Quick question... are you currently handling calls yourself right now?"
  ],
  secondQuestionParts: [
    "Yeah... got it.",
    "Do you ever miss calls... when things get busy?"
  ],
  microValueParts: [
    "Yeah... that makes sense.",
    "That's exactly the kind of thing we help with.",
    "We basically catch those missed calls... and turn them into bookings."
  ],
  offerHandoffParts: [
    "Honestly... this is probably easier... if someone on our team walks you through it properly.",
    "Would you like me to connect you... real quick?"
  ],
  confirmHandoffParts: [
    "Perfect.",
    "Give me one second."
  ],
  declineHandoffParts: [
    "No problem at all.",
    "If later makes more sense... we can always follow up then.",
    "Appreciate your time."
  ],
  rejectParts: [
    "No worries at all.",
    "If anything changes down the line... feel free to reach out.",
    "Appreciate your time... have a great day."
  ],
  busyParts: [
    "Got it... totally understand.",
    "We can always follow up... another time that works better for you."
  ],
  repromptConnectParts: [
    "No pressure at all.",
    "Would you like me to connect you now... or would later be better?"
  ]
};

async function synthesizeSpeech(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !BASE_URL) {
    throw new Error("Missing ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, or BASE_URL");
  }

  const fileName = `${hashText(text)}.mp3`;
  const filePath = path.join(AUDIO_DIR, fileName);
  const publicUrl = `${BASE_URL}/audio/${fileName}`;

  if (fs.existsSync(filePath)) return publicUrl;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: ELEVENLABS_STABILITY,
          similarity_boost: ELEVENLABS_SIMILARITY,
          style: ELEVENLABS_STYLE,
          use_speaker_boost: true
        }
      })
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

async function synthesizeMany(parts = []) {
  const urls = [];
  for (const part of parts.filter(Boolean)) {
    urls.push(await synthesizeSpeech(part));
  }
  return urls;
}

async function buildReactionPrefixedParts(style, mainParts) {
  return [getFiller(style), ...mainParts];
}

async function generateShortReply(userText, stage, reactionStyle) {
  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: `
You are Ryan from Ringmate.
You are a calm, experienced male caller.

Your speech must sound conversational, not like reading a script.
Use short spoken lines.
Use pauses naturally.
Sound like you are listening.

Rules:
- max 2 short spoken lines
- spoken English only
- no long explanations
- move toward either a qualifying question, a handoff offer, or a polite exit
- include natural pause marks like "..." when helpful

Current stage: ${stage}
Reaction style: ${reactionStyle}
          `.trim()
        },
        {
          role: "user",
          content: `Customer said: "${userText}"\nWrite Ryan's next spoken reply only.`
        }
      ],
      max_output_tokens: 70
    });

    return response.output_text?.trim() || "Yeah... Would you like me to connect you real quick?";
  } catch (error) {
    console.error("OpenAI error:", error);
    return "Yeah... Would you like me to connect you real quick?";
  }
}

app.get("/", (_req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

app.post("/voice/incoming", async (req, res) => {
  try {
    const callSid = req.body.CallSid || `call_${Date.now()}`;
    const session = getSession(callSid);
    session.stage = "permission";

    const openingText = MSG.openingParts.join(" ");
    saveTurn(session, "assistant", openingText);

    const audioUrls = await synthesizeMany(MSG.openingParts);
    res.type("text/xml");
    return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
  } catch (error) {
    console.error("/voice/incoming error:", error);
    res.type("text/xml");
    return res.send(twiml(`<Say>Sorry, something went wrong.</Say><Hangup/>`));
  }
});

app.post("/voice/respond", async (req, res) => {
  try {
    const callSid = req.body.CallSid || `call_${Date.now()}`;
    const speechText = req.body.SpeechResult || "";
    const session = getSession(callSid);
    const intent = detectIntent(speechText);
    const reactionStyle = detectReactionStyle(speechText);
    session.reactionStyle = reactionStyle;

    saveTurn(session, "user", speechText);

    if (intent === "reject") {
      session.callOutcome = "rejected";
      const audioUrls = await synthesizeMany(MSG.rejectParts);
      saveTurn(session, "assistant", MSG.rejectParts.join(" "));
      res.type("text/xml");
      return res.send(twimlPlaySequenceAndHangup(audioUrls));
    }

    if (intent === "busy" && session.stage !== "handoff_permission") {
      session.callOutcome = "follow_up";
      const audioUrls = await synthesizeMany(MSG.busyParts);
      saveTurn(session, "assistant", MSG.busyParts.join(" "));
      res.type("text/xml");
      return res.send(twimlPlaySequenceAndHangup(audioUrls));
    }

    if (session.stage === "permission") {
      let parts;
      if (intent === "why_calling") {
        session.stage = "question_1";
        session.questionCount = 1;
        parts = MSG.whyCallingParts;
      } else {
        session.stage = "question_1";
        session.questionCount = 1;
        parts = MSG.permissionOkayParts;
      }

      const audioUrls = await synthesizeMany(parts);
      saveTurn(session, "assistant", parts.join(" "));
      res.type("text/xml");
      return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
    }

    if (session.stage === "question_1") {
      if (intent === "deep_question") {
        session.stage = "handoff_permission";
        session.handoffOffered = true;
        const parts = await buildReactionPrefixedParts(reactionStyle, MSG.offerHandoffParts);
        const audioUrls = await synthesizeMany(parts);
        saveTurn(session, "assistant", parts.join(" "));
        res.type("text/xml");
        return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
      }

      session.stage = "question_2";
      session.questionCount = 2;
      const parts = await buildReactionPrefixedParts(reactionStyle, [MSG.secondQuestionParts[1]]);
      const audioUrls = await synthesizeMany(parts);
      saveTurn(session, "assistant", parts.join(" "));
      res.type("text/xml");
      return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
    }

    if (session.stage === "question_2") {
      if (["self_handle", "interest", "deep_question"].includes(intent)) {
        session.stage = "handoff_permission";
        session.handoffOffered = true;
        const parts = [getFiller(reactionStyle), ...MSG.microValueParts, ...MSG.offerHandoffParts];
        const audioUrls = await synthesizeMany(parts);
        saveTurn(session, "assistant", parts.join(" "));
        res.type("text/xml");
        return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
      }

      const aiReply = await generateShortReply(speechText, session.stage, reactionStyle);
      session.stage = "handoff_permission";
      session.handoffOffered = true;
      const parts = [getFiller(reactionStyle), aiReply];
      const audioUrls = await synthesizeMany(parts);
      saveTurn(session, "assistant", parts.join(" "));
      res.type("text/xml");
      return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
    }

    if (session.stage === "handoff_permission") {
      if (intent === "confirm_connect" || intent === "interest") {
        session.stage = "handoff_execute";
        session.handoffConfirmed = true;
        session.callOutcome = "transferred";
        const audioUrls = await synthesizeMany(MSG.confirmHandoffParts);
        saveTurn(session, "assistant", MSG.confirmHandoffParts.join(" "));
        res.type("text/xml");
        return res.send(twimlPlaySequenceAndDial(audioUrls, HUMAN_FORWARD_NUMBER));
      }

      if (intent === "decline_connect" || intent === "busy") {
        session.callOutcome = "deferred";
        const audioUrls = await synthesizeMany(MSG.declineHandoffParts);
        saveTurn(session, "assistant", MSG.declineHandoffParts.join(" "));
        res.type("text/xml");
        return res.send(twimlPlaySequenceAndHangup(audioUrls));
      }

      const parts = await buildReactionPrefixedParts(reactionStyle, [MSG.repromptConnectParts[1]]);
      const audioUrls = await synthesizeMany(parts);
      saveTurn(session, "assistant", parts.join(" "));
      res.type("text/xml");
      return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
    }

    const fallbackParts = [getFiller(reactionStyle), "Quick question... are you currently handling calls yourself right now?"];
    const audioUrls = await synthesizeMany(fallbackParts);
    saveTurn(session, "assistant", fallbackParts.join(" "));
    res.type("text/xml");
    return res.send(twimlPlaySequenceAndGather(audioUrls, "/voice/respond"));
  } catch (error) {
    console.error("/voice/respond error:", error);
    res.type("text/xml");
    return res.send(twiml(`<Say>Sorry about that. We will follow up another time.</Say><Hangup/>`));
  }
});

app.get("/debug/session/:callSid", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
