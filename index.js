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
        stability: 0.35,
        similarity_boost: 0.85,
        style: 0.18,
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
// Call flow helpers
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
// OpenAI reply generator
// -----------------------------
async function generateReply(step, userText = "") {
  const trimmedUserText = (userText || "").trim();

  if (!trimmedUserText) {
    if (step === "intro") {
      return "Got it. Do you ever miss calls when things get busy?";
    }
    if (step === "problem-check") {
      return "I see. This is actually an AI assistant. Would you be open to trying something like this?";
    }
    return "No worries. Thanks for your time.";
  }

  let stageInstruction = "";

  if (step === "intro") {
    stageInstruction = `
You are in the early discovery part of the call.
Goal:
- Briefly react to what the person said
- Ask whether they ever miss calls when things get busy

Output rules:
- Max 2 short sentences
- Sound natural and human
- No long explanations
- Do not mention pricing
- Do not say you are AI yet
`;
  } else if (step === "problem-check") {
    stageInstruction = `
You are in the offer transition part of the call.
Goal:
- Briefly react
- Say in one short sentence that Ringmate helps capture missed calls and turn them into bookings
- Then say this is an AI assistant
- Then ask if they would be open to trying something like this

Output rules:
- Max 3 very short sentences
- Sound casual and natural
- Keep it concise
- No pricing
- No technical explanation
`;
  } else {
    stageInstruction = `
You are in the closing part of the call.
Goal:
- If the user sounds positive/interested, politely say someone will follow up
- If the user sounds negative/not interested, politely thank them and end
- If unclear, end politely and lightly

Output rules:
- Max 2 short sentences
- End the call naturally
- No extra pitch
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 80,
    messages: [
      {
        role: "system",
        content: `
You are Emily from Ringmate calling a small business.

Important style rules:
- Sound like a real human, not a chatbot
- Use short spoken sentences
- Be warm, calm, and casual
- Do not be overly cheerful
- Never ramble
- Never use bullet points
- Never give long explanations
- Keep the call moving
- Stay focused on missed calls / bookings
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
      return "Got it. Do you ever miss calls when things get busy?";
    }
    if (step === "problem-check") {
      return "I see. This is actually an AI assistant. Would you be open to trying something like this?";
    }
    return "No worries. Thanks for your time.";
  }

  return text.replace(/\s+/g, " ").trim();
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

    if (!ELEVENLABS_API_KEY || !VOICE_ID || !PUBLIC_BASE_URL || !OPENAI_API_KEY) {
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

    const text = await generateReply(step, userText);
    console.log("aiReply:", text);

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

    const fallbackText = "Sorry — something went wrong. Thanks for your time.";
    const fallbackAudioUrl = await createSingleAudioUrl(fallbackText);
    const twiml = buildHangupTwiml(fallbackAudioUrl);

    res.set("Content-Type", "text/xml");
    return res.send(twiml);
  }
});

app.listen(PORT, () => {
  console.log(`Ringmate Sales AI Server Running on port ${PORT}`);
});
