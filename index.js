import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;

// 🔥 핵심: 빠른 TTS 함수 (turbo 모델)
async function generateSpeech(text) {
  const response = await axios({
    method: "POST",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "accept": "audio/mpeg"
    },
    data: {
      text: text,
      model_id: "eleven_turbo_v2", // 🔥 속도 핵심
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.25,
        use_speaker_boost: true
      }
    },
    responseType: "arraybuffer"
  });

  return Buffer.from(response.data, "binary");
}

// 🚀 Twilio Webhook
app.post("/webhook", async (req, res) => {
  try {
    // 🔥 한 문장씩 끊어서 생성 (핵심 UX)
    const lines = [
      "Hi — this is Alex from Ringmate.",
      "Quick question —",
      "Are you handling calls yourself right now?"
    ];

    // 첫 문장만 빠르게 재생 (속도 체감 ↑)
    const audioBuffer = await generateSpeech(lines[0]);

    res.set("Content-Type", "audio/mpeg");
    return res.send(audioBuffer);

  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

// 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Ringmate Sales AI Server Running");
});
