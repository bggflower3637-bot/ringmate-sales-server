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
// TwiML helpers
// -----------------------------
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
// Fixed text blocks
// -----------------------------
function getWarmupText() {
  return [
    "Hi — this is Emily with Ringmate.",
    "We help businesses handle missed calls and turn them into bookings.",
    "Hope you're having a good day so far.",
  ].join(" ");
}

function getSimpleQuestionAnswer() {
  return [
    "Yeah — absolutely.",
    "We help businesses catch missed calls and turn them into bookings.",
  ].join(" ");
}

function getDeepQuestionHandoffText() {
  return [
    "Got it — great question.",
    "One of our team members can walk you through that in more detail.",
    "They’ll reach out shortly.",
  ].join(" ");
}

function getInterestedHandoffText() {
  return [
    "That makes sense.",
    "I’ll have someone from our team reach out and walk you through it.",
    "Really appreciate your time today.",
  ].join(" ");
}

function getNotInterestedClosingText() {
  return [
    "No worries at all.",
    "Thanks for taking the call.",
    "Have a great rest of your day.",
  ].join(" ");
}

function getSoftClosingText() {
  return [
    "Totally understand.",
    "If it ever becomes a problem, we'd be happy to help.",
    "Really appreciate your time today.",
  ].join(" ");
}

// -----------------------------
// Detection helpers
// -----------------------------
function normalizeText(text = "") {
  return text.toLowerCase().trim();
}

function isSimpleQuestion(text = "") {
  const t = normalizeText(text);

  return (
    t.includes("what is this") ||
    t.includes("what's this") ||
    t.includes("what is this about") ||
    t.includes("what's this about") ||
    t.includes("what do you do") ||
    t.includes("who is this") ||
    t.includes("why are you calling") ||
    t.includes("what is ringmate") ||
    t === "what is this" ||
    t === "who is this" ||
    t === "why are you calling"
  );
}

function isDeepQuestion(text = "") {
  const t = normalizeText(text);

  return (
    t.includes("how does it work") ||
    t.includes("how exactly") ||
    t.includes("how much") ||
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("features") ||
    t.includes("difference") ||
    t.includes("compare") ||
    t.includes("integration") ||
    t.includes("setup") ||
    t.includes("what does it cost")
  );
}

function detectIntent(text = "") {
  const t = normalizeText(text);

  if (!t) return "empty";

  if (
    t.includes("not interested") ||
    t.includes("no thanks") ||
    t.includes("we're good") ||
    t.includes("we are good") ||
    t.includes("don't need") ||
    t.includes("do not need") ||
    t.includes("nope") ||
    t.includes("not really")
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
    t.includes("possibly") ||
    t.includes("interested") ||
    t.includes("sounds good") ||
    t.includes("that works")
  ) {
    return "positive";
  }

  return "neutral";
}

function soundsInterested(text = "") {
  const t = normalizeText(text);

  return (
    t.includes("yes") ||
    t.includes("yeah") ||
    t.includes("sure") ||
    t.includes("okay") ||
    t.includes("ok") ||
    t.includes("interested") ||
    t.includes("open to that") ||
    t.includes("open to it") ||
    t.includes("sounds good") ||
    t.includes("that works") ||
    t.includes("maybe")
  );
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getReaction(intent) {
  const reactions = {
    positive: ["Got it.", "Okay.", "Right."],
    pain: ["Yeah — that happens.", "I hear you.", "Got it."],
    negative: ["I see.", "Got it.", "Okay."],
    neutral: ["Mm-hmm.", "I see.", "Gotcha."],
    empty: ["Got it."],
  };

  return pickRandom(reactions[intent] || reactions.neutral);
}

// -----------------------------
// OpenAI core generation
// -----------------------------
async function generateShortReply(step, userText = "") {
  const trimmedUserText = (userText || "").trim();

  if (!trimmedUserText) {
    if (step === "intro") {
      return "Just wanted to ask real quick — are you usually the one handling calls there?";
    }

    if (step === "problem-check") {
      return "Would you be open to learning a little more about something like this?";
    }

    return "Thanks again for your time.";
  }

  let stageInstruction = "";

  if (step === "intro") {
    stageInstruction = `
Goal:
- Move naturally into a short discovery question

Rules:
- Return only 1 or 2 short spoken sentences
- Do not explain the company again
- Do not mention AI
- Do not mention pricing
- Keep it conversational
- End with one short question
`;
  } else if (step === "problem-check") {
    stageInstruction = `
Goal:
- Briefly say Ringmate helps with missed calls and bookings
- Ask whether they would be open to learning more

Rules:
- Return only 2 or 3 short spoken sentences
- Keep it concise
- No pricing
- No technical explanation
- No long pitch
`;
  } else {
    stageInstruction = `
Goal:
- End politely

Rules:
- Return only 1 short spoken sentence
- No extra pitch
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.25,
    max_tokens: 50,
    messages: [
      {
        role: "system",
        content: `
You are Emily from Ringmate speaking on a phone call.

Style rules:
- Sound human, calm, and casual
- Sound spoken, not written
- Keep it short
- Never ramble
- Use simple natural phone language
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
      return "Just wanted to ask real quick — are you usually the one handling calls there?";
    }

    if (step === "problem-check") {
      return "Would you be open to learning a little more about something like this?";
    }

    return "Thanks again for your time.";
  }

  return text.replace(/\s+/g, " ").trim();
}

async function generateReply(step, userText = "") {
  const intent = detectIntent(userText);
  const reaction = getReaction(intent);
  const core = await generateShortReply(step, userText);

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

    const warmupText = getWarmupText();
    const warmupAudioUrl = await createSingleAudioUrl(warmupText);
    const twiml = buildGatherTwiml(warmupAudioUrl, "warmup");

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
    const step = req.query.step || "warmup";
    const userText = req.body.SpeechResult || "";

    console.log("===== /voice/process called =====");
    console.log("step:", step);
    console.log("userText:", userText);

    // 1) 얕은 질문 -> AI가 짧게 설명
    if (isSimpleQuestion(userText)) {
      const replyText = getSimpleQuestionAnswer();
      const audioUrl = await createSingleAudioUrl(replyText);
      const twiml = buildGatherTwiml(audioUrl, "problem-check");

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    // 2) 깊은 질문 -> 사람에게 넘기고 종료
    if (isDeepQuestion(userText)) {
      const replyText = getDeepQuestionHandoffText();
      const audioUrl = await createSingleAudioUrl(replyText);
      const twiml = buildHangupTwiml(audioUrl);

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    // 3) 첫 반응 이후 -> 짧은 질문으로 진입
    if (step === "warmup") {
      const replyText =
        "Got it. Just wanted to ask real quick — are you usually the one handling calls there?";
      const audioUrl = await createSingleAudioUrl(replyText);
      const twiml = buildGatherTwiml(audioUrl, "intro");

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    // 4) 관심 있음 -> 사람 연결 후 종료
    if (soundsInterested(userText)) {
      const replyText = getInterestedHandoffText();
      const audioUrl = await createSingleAudioUrl(replyText);
      const twiml = buildHangupTwiml(audioUrl);

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    // 5) 관심 없음 -> 자연스럽게 종료
    if (detectIntent(userText) === "negative") {
      const replyText = getNotInterestedClosingText();
      const audioUrl = await createSingleAudioUrl(replyText);
      const twiml = buildHangupTwiml(audioUrl);

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    // 6) 나머지 -> 짧게 진행
    const replyText = await generateReply(step, userText);
    console.log("aiReply:", replyText);

    if (step === "problem-check") {
      const audioUrl = await createSingleAudioUrl(replyText);
      const twiml = buildGatherTwiml(audioUrl, "close");

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    if (step === "close") {
      const finalText = getSoftClosingText();
      const audioUrl = await createSingleAudioUrl(finalText);
      const twiml = buildHangupTwiml(audioUrl);

      res.set("Content-Type", "text/xml");
      return res.send(twiml);
    }

    const audioUrl = await createSingleAudioUrl(replyText);
    const twiml = buildGatherTwiml(audioUrl, "problem-check");

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
