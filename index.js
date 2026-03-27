import express from "express";
import axios from "axios";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// 오디오 임시 저장소
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
        style: 0.3,
        use_speaker_boost: true
      }
    },
    responseType: "arraybuffer"
  });

  return Buffer.from(response.data);
}

// -----------------------------
// 오디오 저장
// -----------------------------
function saveAudio(id, buffer) {
  audioStore.set(id, buffer);

  setTimeout(() => {
    audioStore.delete(id);
  }, 10 * 60 * 1000);
}

// -----------------------------
// 여러 문장을 오디오 URL로 변환
// -----------------------------
async function createAudioUrls(lines) {
  const urls = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    console.log(`Generating speech ${i + 1}/${lines.length}:`, line);

    const buffer = await generateSpeech(line);
    const id = `line-${Date.now()}-${i}`;

    saveAudio(id, buffer);

    const url = `${PUBLIC_BASE_URL}/audio/${id}`;
    urls.push(url);

    console.log("Saved audio URL:", url);
  }

  return urls;
}

// -----------------------------
// TwiML 생성
// -----------------------------
function buildTwiml(urls, gatherAction = "/voice/process") {
  let twiml = `<?xml version="1.0" encoding="UTF-8"?>`;
  twiml += `<Response>`;

  for (const url of urls) {
    twiml += `<Play>${url}</Play>`;
    twiml += `<Pause length="1"/>`;
  }

  // 상대방 말 받기용 Gather
  twiml += `
    <Gather input="speech" action="${gatherAction}" method="POST" speechTimeout="auto" language="en-US">
    </Gather>
  `;

  twiml += `</Response>`;
  return twiml;
}

// -----------------------------
// 간단한 의도 분류
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

// -----------------------------
// 리액션 선택
// -----------------------------
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
// 단계별 다음 멘트
// -----------------------------
function getNextLines(step, userText = "") {
  const intent = detectIntent(userText);
  const reaction = getReaction(intent);

  if (step === "intro") {
    return [
      reaction,
      "Do you ever miss calls when things get busy?"
    ];
  }

  if (step === "problem-check") {
    return [
      reaction,
      "We help capture missed calls and turn them into bookings.",
      "By the way — this is actually an AI assistant.",
      "Would you be open to trying something like this?"
    ];
  }

  if (step === "close") {
    if (intent === "positive") {
      return [
        "Nice.",
        "I’ll have someone follow up with you."
      ];
    }

    if (intent === "negative") {
      return [
        "All good.",
        "Appreciate your time."
      ];
    }

    return [
      "No worries.",
      "Just wanted to check."
    ];
  }

  return [
    "Mm-hmm.",
    "Could you say that again?"
  ];
}

// -----------------------------
// 서버 상태 확인
// -----------------------------
app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Server Running");
});

// -----------------------------
// 저장된 오디오 제공
// -----------------------------
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

// -----------------------------
// 첫 진입
// -----------------------------
app.post("/voice/incoming", async (req, res) => {
  try {
    console.log("===== /voice/incoming called =====");
    console.log("ENV CHECK:", {
      hasApiKey: !!ELEVENLABS_API_KEY,
      hasVoiceId: !!VOICE_ID,
      hasBaseUrl: !!PUBLIC_BASE_URL,
      baseUrl: PUBLIC_BASE_URL || null
    });

    if (!ELEVENLABS_API_KEY || !VOICE_ID || !PUBLIC_BASE_URL) {
      console.log("Missing environment variables");
      return res.status(500).send("Missing environment variables");
    }

    const lines = [
      "Hi — this is Emily from Ringmate.",
      "Quick question.",
      "Are you handling calls yourself right now?"
    ];

    const urls = await createAudioUrls(lines);
    const twiml = buildTwiml(urls, `${PUBLIC_BASE_URL}/voice/process?step=intro`);

    console.log("Generated intro TwiML successfully");

    res.set("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (error) {
    console.error("incoming error:");
    console.error("message:", error.message);

    if (error.response) {
      console.error("status:", error.response.status);
      console.error("data:", error.response.data);
    }

    return res.status(500).send("Server error");
  }
});

// -----------------------------
// 상대방 음성 처리
// -----------------------------
app.post("/voice/process", async (req, res) => {
  try {
    const step = req.query.step || "intro";
    const userText = req.body.SpeechResult || "";

    console.log("===== /voice/process called =====");
    console.log("step:", step);
    console.log("userText:", userText);

    let nextStep = "problem-check";

    if (step === "problem-check") {
      nextStep = "close";
    } else if (step === "close") {
      nextStep = "done";
    }

    const lines = getNextLines(step, userText);
    const urls = await createAudioUrls(lines);

    let twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>`;

    for (const url of urls) {
      twiml += `<Play>${url}</Play>`;
      twiml += `<Pause length="1"/>`;
    }

    if (nextStep !== "done") {
      twiml += `
        <Gather input="speech" action="${PUBLIC_BASE_URL}/voice/process?step=${nextStep}" method="POST" speechTimeout="auto" language="en-US">
        </Gather>
      `;
    } else {
      twiml += `<Hangup/>`;
    }

    twiml += `</Response>`;

    console.log("Generated process TwiML successfully");

    res.set("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (error) {
    console.error("process error:");
    console.error("message:", error.message);

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
