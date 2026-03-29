import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Ringmate server running");
});

app.post("/voice", (req, res) => {
  console.log("📞 Incoming call");

  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <ConversationRelay
          url="wss://ringmate-sales-server.onrender.com/ws"
          welcomeGreeting=" "
          interruptible="speech"
          language="en-US"
          ttsProvider="Google"
          voice="en-US-Standard-C" />
      </Connect>
    </Response>
  `);
});

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

wss.on("connection", (ws) => {
  console.log("🔌 Twilio ConversationRelay connected");

  let isGenerating = false;
  let currentAbortController = null;
  let stage = "intro";
  let activeResponseId = 0;

  const conversation = [
    {
      role: "system",
      content: `
You are a human sales caller on a live phone call.
You work for Ringmate.

Style rules:
- Sound like a real person
- Calm, short, warm, conversational
- Never sound like customer support
- Never sound formal
- Never over-explain
- Usually 1 short sentence, max 2 short sentences
- Ask one question at a time
- React first, then ask
- Use natural fillers like "yeah", "got it", "okay", "right"
- Use spoken pauses with dashes like "—"
- Keep the flow natural
- Make it feel like a real live call

Important:
- First line should be casual, not salesy
- After the first small greeting exchange, move gently into sales
- Often begin with a short reaction before the main sentence
- Sound like you are thinking naturally, not reading a script

Good examples:
- "Yeah — got it. Quick question — are you handling calls yourself right now?"
- "Okay — makes sense. Do you ever miss calls when things get busy?"
- "Right — got it. About how many calls do you usually get in a day?"
      `.trim(),
    },
  ];

  ws.send(
    JSON.stringify({
      type: "text",
      token: "Hi — how’s it going?",
      last: true,
    })
  );

  async function sendThinkingFiller(responseId) {
    const fillers = [
      "Yeah —",
      "Okay —",
      "Got it —",
      "Right —",
      "Mm-hmm —",
    ];

    const filler = pickRandom(fillers);

    if (responseId !== activeResponseId) return false;

    ws.send(
      JSON.stringify({
        type: "text",
        token: filler,
        last: false,
      })
    );

    await wait(180);

    return responseId === activeResponseId;
  }

  async function streamAssistantReply(userText) {
    isGenerating = true;
    activeResponseId += 1;
    const thisResponseId = activeResponseId;

    conversation.push({
      role: "user",
      content: userText,
    });

    const abortController = new AbortController();
    currentAbortController = abortController;

    let fullAssistantText = "";
    let pendingToken = null;

    try {
      const fillerStillValid = await sendThinkingFiller(thisResponseId);
      if (!fillerStillValid || abortController.signal.aborted) {
        return;
      }

      const stream = await openai.chat.completions.create(
        {
          model: "gpt-4o-mini",
          stream: true,
          temperature: 0.35,
          max_tokens: 60,
          messages: conversation,
        },
        {
          signal: abortController.signal,
        }
      );

      for await (const chunk of stream) {
        if (abortController.signal.aborted || thisResponseId !== activeResponseId) {
          return;
        }

        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (!delta) continue;

        fullAssistantText += delta;

        if (pendingToken !== null) {
          ws.send(
            JSON.stringify({
              type: "text",
              token: pendingToken,
              last: false,
            })
          );
        }

        pendingToken = delta;
      }

      if (abortController.signal.aborted || thisResponseId !== activeResponseId) {
        return;
      }

      if (pendingToken !== null) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: pendingToken,
            last: true,
          })
        );
      } else {
        const fallback = "Sorry — could you say that again?";

        ws.send(
          JSON.stringify({
            type: "text",
            token: fallback,
            last: true,
          })
        );

        fullAssistantText = fallback;
      }

      // filler까지 포함해서 메모리에 남기기
      const rememberedText = `${fullAssistantText}`.trim();

      conversation.push({
        role: "assistant",
        content: rememberedText,
      });

      if (conversation.length > 12) {
        const systemMessage = conversation[0];
        const recent = conversation.slice(-10);
        conversation.length = 0;
        conversation.push(systemMessage, ...recent);
      }

      console.log("🤖 Assistant:", fullAssistantText);
    } catch (error) {
      if (error?.name === "AbortError") {
        console.log("⛔ OpenAI request aborted");
        return;
      }

      console.error("❌ Error:", error);

      try {
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Sorry — I hit a problem on my side.",
            last: true,
          })
        );
      } catch {}
    } finally {
      if (thisResponseId === activeResponseId) {
        isGenerating = false;
        currentAbortController = null;
      }
    }
  }

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("📩 From Twilio:", msg);

      if (msg.type === "setup") return;
      if (msg.type !== "prompt") return;

      const userText = (msg.voicePrompt || msg.transcript || "").trim();
      if (!userText) return;

      console.log("👤 User said:", userText);

      if (currentAbortController) {
        try {
          currentAbortController.abort();
          console.log("⛔ Aborted current response due to interrupt");
        } catch {}
        currentAbortController = null;
        isGenerating = false;
      }

      activeResponseId += 1;

      if (stage === "intro") {
        stage = "sales";

        conversation.push({
          role: "user",
          content: userText,
        });

        ws.send(
          JSON.stringify({
            type: "text",
            token: "Yeah — got it. Quick question — are you handling calls yourself right now?",
            last: true,
          })
        );

        conversation.push({
          role: "assistant",
          content: "Yeah — got it. Quick question — are you handling calls yourself right now?",
        });

        return;
      }

      if (isGenerating) {
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Yeah — one second.",
            last: true,
          })
        );
        return;
      }

      await streamAssistantReply(userText);
    } catch (error) {
      console.error("❌ WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    if (currentAbortController) {
      try {
        currentAbortController.abort();
      } catch {}
    }
    console.log("❌ Twilio ConversationRelay disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
