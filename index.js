import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const audioStore = new Map();

// -----------------------------
// ElevenLabs TTS
// -----------------------------
async function generateSpeech(text) {
  const response = await axios({
    method: "POST",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    data: {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.08,
        use_speaker_boost: true,
      },
    },
    responseType: "arraybuffer",
  });

  return Buffer.from(response.data);
}

// -----------------------------
// Audio store
// -----------------------------
function saveAudio(id, buffer) {
  audioStore.set(id, buffer);

  setTimeout(() => {
    audioStore.delete(id);
  }, 10 * 60 * 1000);
}

async function createSingleAudioUrl(text) {
  const buffer = await generateSpeech(text);
  const id = `audio-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  saveAudio(id, buffer);
  return `${PUBLIC_BASE_URL}/audio/${id}`;
}

// -----------------------------
// Call flow
// -----------------------------
function getNextStep(currentStep) {
  if (currentStep === "intro") return "problem-check";
  if (currentStep === "problem-check") return "close";
  return "done";
}

function buildGatherTwiml(audioUrl, nextStep) {
  return `
<Response>
  <Play>${audioUrl}</Play>
  <Gather
    input="speech"
    speechTimeout="auto"
    action="${PUBLIC_BASE_URL}/voice/process?step=${nextStep}"
    method="POST"
    actionOnEmptyResult="true"
  />
  <Redirect method="POST">${PUBLIC_BASE_URL}/voice/process?step=${nextStep}</Redirect>
</Response>`;
}

function buildHangupTwiml(audioUrl) {
  return `
<Response>
  <Play>${audioUrl}</Play>
  <Hangup />
</Response>`;
}

// -----------------------------
// Lightweight intent + reaction
// -----------------------------
function detectIntent(text = "") {
  const t = text.toLowerCase();

  if (!t.trim()) return "empty";

  if (
    t.includes("not interested") ||
    t.includes("no thanks") ||
    t.includes("we're good") ||
    t.includes("we are good") ||
    t.includes("don't need") ||
    t.includes("do not need") ||
    t.includes("nope")
  ) {
    return "negative";
  }

  if (
    t.includes("sometimes") ||
    t.includes("busy") ||
    t.includes("miss calls") ||
    t.includes("missed calls") ||
    t.includes("too many calls") ||
    t.includes("can't answer") ||
    t.includes("cannot answer") ||
    t.includes("hard to keep up")
  ) {
    return "pain";
  }

  if (
    t.includes("yeah") ||
    t.includes("yes") ||
    t.includes("sure") ||
    t.includes("okay") ||
    t.includes("ok") ||
    t.includes("maybe") ||
    t.includes("possibly")
  ) {
    return "positive";
  }

  if (
    t.includes("haha") ||
    t.includes("lol") ||
    t.includes("funny")
  ) {
    return "light";
  }

  return "neutral";
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getReaction(intent, step) {
  const reactions = {
    intro: {
      positive: ["Got it.", "Okay.", "Right."],
      pain: ["Yeah — that happens.", "I hear you.", "Got it."],
      light: ["Haha, yeah.", "Fair enough.", "Yeah."],
      negative: ["I see.", "Got it.", "Okay."],
      neutral: ["Mm-hmm.", "I see.", "Gotcha."],
      empty: ["Got it."],
    },
    "problem-check": {
      positive: ["That makes sense.", "Got it.", "Right."],
      pain: ["Yeah — that happens.", "Totally.", "I get that."],
      light: ["Yeah, fair enough.", "Haha, yeah.", "Got it."],
      negative: ["No problem.", "I understand.", "Got it."],
      neutral: ["I see.", "Mm-hmm.", "Gotcha."],
      empty: ["I see."],
    },
    close: {
      positive: ["Sounds good.", "Perfect.", "Great."],
      pain: ["Got it.", "I understand.", "Okay."],
      light: ["Fair enough.", "Alright.", "Okay."],
      negative: ["No worries.", "Totally fine.", "Got it."],
      neutral: ["Alright.", "Okay.", "I see."],
      empty: ["No worries."],
    },
  };

  const stepMap = reactions[step] || reactions.intro;
  return pickRandom(stepMap[intent] || stepMap.neutral);
}

// -----------------------------
// OpenAI generation
// -----------------------------
async function generateCoreReply(step, userText = "") {
  const trimmedUserText = (userText || "").trim();

  if (!trimmedUserText) {
    if (step === "intro") {
      return "Do you ever miss calls when things get busy?";
    }
    if (step === "problem-check") {
      return "We help capture missed calls and turn them into bookings. This is actually an AI assistant. Would you be open to trying something like this?";
    }
    return "Thanks for your time.";
  }

  let stageInstruction = "";

  if (step === "intro") {
    stageInstruction = `
Goal:
- Ask whether they ever miss calls when things get busy

Rules:
- Return only ONE short spoken follow-up question
- Prefer 6 to 10 words
- Do not include a reaction
- Do not explain
- Do not mention AI yet
- Do not mention pricing
`;
  } else if (step === "problem-check") {
    stageInstruction = `
Goal:
- Briefly say Ringmate helps capture missed calls and turn them into bookings
- Mention this is an AI assistant
- Ask if they would be open to trying something like this

Rules:
- Return only 2 or 3 very short spoken sentences
- Do not include a reaction
- Keep it concise
- No pricing
- No technical explanation
`;
  } else {
    stageInstruction = `
Goal:
- If the person sounds interested, say someone will follow up
- If not interested, politely thank them and end
- If unclear, end politely

Rules:
- Return only 1 or 2 short spoken sentences
- Do not include a reaction
- No extra pitch
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.25,
    max_tokens: 40,
    messages: [
      {
        role: "system",
        content: `
You are Emily from Ringmate speaking on a phone call.

Style rules:
- Sound human and casual
- Sound spoken, not written
- Keep it short
- Never ramble
- Use simple words
- No bullet points
- No polished sales language
        `.trim(),
      },
      {
        role: "system",
        content: stageInstruction.trim(),
      },
      {
        role: "user",
        content: `The person said: "${trimmedUserText}"`,
      },
    ],
  });

  const text = response.choices?.[0]?.message?.content?.trim();

  if (!text) {
    if (step === "intro") {
      return "Do you ever miss calls when things get busy?";
    }
    if (step === "problem-check") {
      return "We help capture missed calls and turn them into bookings. This is actually an AI assistant. Would you be open to trying something like this?";
    }
    return "Thanks for your time.";
  }

  return text.replace(/\s+/g, " ").trim();
}

async function generateReply(step, userText = "") {
  const intent = detectIntent(userText);
  const reaction = getReaction(intent, step);
  const core = await generateCoreReply(step, userText);

  if (!core) return reaction;
  return `${reaction} ${core}`.replace(/\s+/g, " ").trim();
}

// -----------------------------
// Routes
// -----------------------------
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Server Running");
});

app.get("/audio/:id", (req, res) => {
  const { id } = req.params;
  const audio = audioStore.get(id);

  if (!audio) {
    console.log("Audio not found:", id);
    return res.status(404).send("Audio not found");
  }

  res.set("Content-Type", "audio/mpeg");
  return res.send(audio);
});

app.post("/voice/incoming", async (req, res) => {
  try {
    console.log("===== /voice/incoming called =====");

    if (
      !ELEVENLABS_API_KEY ||
      !VOICE_ID ||
      !PUBLIC_BASE_URL ||
      !OPENAI_API_KEY
    ) {
      return res.status(500).send("Missing environment variables");
    }

    const introText =
      "Hi — this is Emily from Ringmate. Quick question. Are you handling calls yourself right now?";

    const introAudioUrl = await createSingleAudioUrl(introText);
    const twiml = buildGatherTwiml(introAudioUrl, "intro");

    res.set("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (error) {
    console.error("incoming error:", error.message);

    if (error.response) {
      console.error("status:", error.response.status);
      console.error("data:", error.response.data);
    }

    return res.status(500).send("Server error");
  }
});

app.post("/voice/process", async (req, res) => {
  try {
    const step = req.query.step || "intro";
    const userText = req.body.SpeechResult || "";

    console.log("===== /voice/process called =====");
    console.log("step:", step);
    console.log("userText:", userText);

    const replyText = await generateReply(step, userText);
    console.log("aiReply:", replyText);

    const audioUrl = await createSingleAudioUrl(replyText);
    const nextStep = getNextStep(step);

    const twiml =
      nextStep === "done"
        ? buildHangupTwiml(audioUrl)
        : buildGatherTwiml(audioUrl, nextStep);

    res.set("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (error) {
    console.error("process error:", error.message);

    if (error.response) {
      console.error("status:", error.response.status);
      console.error("data:", error.response.data);
    }

    try {
      const fallbackText = "Sorry — something went wrong. Thanks for your time.";
      const fallbackAudioUrl = await createSingleAudioUrl(fallbackText);
      const twiml = buildHangupTwiml(fallbackAudioUrl);

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    } catch (fallbackError) {
      console.error("fallback error:", fallbackError.message);
      return res.status(500).send("Server error");
    }
  }
});

app.listen(PORT, () => {
  console.log(`Ringmate Sales AI Server Running on port ${PORT}`);
});
