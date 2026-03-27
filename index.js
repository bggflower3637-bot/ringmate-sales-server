import express from "express";
import axios from "axios";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// 메모리 임시 저장
const audioStore = new Map();

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
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.25,
        use_speaker_boost: true
      }
    },
    responseType: "arraybuffer"
  });

  return Buffer.from(response.data);
}

function saveAudio(id, buffer) {
  audioStore.set(id, buffer);

  setTimeout(() => {
    audioStore.delete(id);
  }, 1000 * 60 * 10);
}

function buildTwiml(urls) {
  let twiml = `<?xml version="1.0" encoding="UTF-8"?>`;
  twiml += `<Response>`;

  for (const url of urls) {
    twiml += `<Play>${url}</Play>`;
    twiml += `<Pause length="1"/>`;
  }

  twiml += `</Response>`;
  return twiml;
}

app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Server Running");
});

app.get("/audio/:id", (req, res) => {
  const { id } = req.params;
  const audio = audioStore.get(id);

  if (!audio) {
    return res.status(404).send("Audio not found");
  }

  res.set("Content-Type", "audio/mpeg");
  return res.send(audio);
});

app.post("/voice/incoming", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY || !VOICE_ID || !PUBLIC_BASE_URL) {
      return res.status(500).send("Missing environment variables");
    }

    const lines = [
      "Hi — this is Alex from Ringmate.",
      "Quick question.",
      "Are you handling calls yourself right now?"
    ];

    const urls = [];

    for (let i = 0; i < lines.length; i += 1) {
      const buffer = await generateSpeech(lines[i]);
      const id = `line-${Date.now()}-${i}`;
      saveAudio(id, buffer);
      urls.push(`${PUBLIC_BASE_URL}/audio/${id}`);
    }

    const twiml = buildTwiml(urls);

    res.set("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (error) {
    console.error("incoming error:", error?.response?.data || error.message);
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Ringmate Sales AI Server Running on port ${PORT}`);
});
