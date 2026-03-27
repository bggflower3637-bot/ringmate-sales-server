import express from "express";
import axios from "axios";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

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
      Accept: "audio/mpeg"
    },
    data: {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.85,
        style: 0.22,
        use_speaker_boost: true
      }
    },
    responseType: "arraybuffer"
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
// Intent detection
// -----------------------------
function detectIntent(text = "") {
  const t = text.toLowerCase();

  if (
    t.includes("haha") ||
    t.includes("funny") ||
    t.includes("terrible") ||
    t.includes("awful") ||
    t.includes("crazy")
  ) {
    return "funny";
  }

  if (
    t.includes("busy") ||
    t.includes("miss") ||
    t.includes("hard") ||
    t.includes("difficult") ||
    t.includes("overwhelmed") ||
    t.includes("too many calls")
  ) {
    return "problem";
  }

  if (
    t.includes("yes") ||
    t.includes("yeah") ||
    t.includes("yep") ||
    t.includes("sure") ||
    t.includes("definitely") ||
    t.includes("of course")
  ) {
    return "positive";
  }

  if (
    t.includes("no") ||
    t.includes("nope") ||
    t.includes("not really") ||
    t.includes("already have") ||
    t.includes("we're good") ||
    t.includes("dont need") ||
    t.includes("don't need")
  ) {
    return "negative";
  }

  return "neutral";
}

function getReaction(intent) {
  switch (intent) {
    case "funny":
      return "Haha — yeah.";
    case "problem":
      return "Yeah — that happens.";
    case "positive":
      return "Got it.";
    case "negative":
      return "I see.";
    default:
      return "Mm-hmm.";
  }
}

// -----------------------------
// Dialogue builder
// -----------------------------
function getStepText(step, userText = "") {
  const intent = detectIntent(userText);
  const reaction = getReaction(intent);

  if (step === "intro") {
    return `${reaction} Do you ever miss calls when things get busy?`;
  }

  if (step === "problem-check") {
    return `${reaction} We help capture missed calls and turn them into bookings. By the way — this is actually an AI assistant. Would you be open to trying something like this?`;
  }

  if (step === "close") {
    if (intent === "positive") {
      return `Nice. I’ll have someone follow up with you.`;
    }

    if (intent === "negative") {
      return `All good. Appreciate your time.`;
    }

    return `No worries. Just wanted to check.`;
  }

  return `Mm-hmm. Could you say that again?`;
}

function getNextStep(currentStep) {
  if (currentStep === "intro") return "problem-check";
  if (currentStep === "problem-check") return "close";
  return "done";
}

// -----------------------------
// TwiML builders
// -----------------------------
function buildGatherTwiml(audioUrl, nextStep) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather
    input="speech"
    action="${PUBLIC_BASE_URL}/voice/process?step=${nextStep}"
    method="POST"
    speechTimeout="1"
    actionOnEmptyResult="true"
    language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_BASE_URL}/voice/process?step=${nextStep}</Redirect>
</Response>`;
}

function buildHangupTwiml(audioUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Hangup/>
</Response>`;
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

    if (!ELEVENLABS_API_KEY || !VOICE_ID || !PUBLIC_BASE_URL) {
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

    const text = getStepText(step, userText);
    const audioUrl = await createSingleAudioUrl(text);
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
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Ringmate Sales AI Server Running on port ${PORT}`);
});
