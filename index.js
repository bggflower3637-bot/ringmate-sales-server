import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

const activeCalls = new Map();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/", (req, res) => {
  res.send("Ringmate SIP realtime server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    // OpenAI webhook에는 무조건 바로 응답
    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") return;

    const callId = event?.data?.call_id;
    if (!callId) {
      console.log("No call_id found");
      return;
    }

    if (activeCalls.has(callId)) {
      console.log("Call already being handled:", callId);
      return;
    }

    activeCalls.set(callId, {
      startedAt: Date.now(),
      accepted: false,
      ws: null,
      openerSent: false
    });

    // 1) 콜 수락
    const acceptRes = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          audio: {
            output: {
              voice: "cedar"
            }
          },
          instructions: `
You are Alex from Ringmate.

ROLE
You are making a real outbound-style business call.
Your job is to sound natural, calm, mature, and easy to talk to.

STYLE
- Speak like a real adult, not a scripted telemarketer.
- Keep sentences short.
- Use one thought at a time.
- Ask only one question at a time.
- Do not give long explanations.
- Do not stack questions.
- Keep the flow conversational.

VOICE
- Calm
- Grounded
- Mature
- Slightly warm
- Moderate pace
- Never rushed
- Never overly cheerful
- Never robotic

BEHAVIOR
- Start speaking first when the call connects.
- After the person answers, briefly acknowledge them.
- Then continue with one short next question.
- If they sound busy, be respectful and brief.
- If they are not interested, exit politely.
- If they show interest, offer a human follow-up.

GOAL
Find out whether they still handle calls manually and whether missed calls are a problem.
If there is interest, move the conversation toward a human follow-up.
          `
        })
      }
    );

    const acceptText = await acceptRes.text();
    console.log("ACCEPT STATUS:", acceptRes.status);
    console.log("ACCEPT BODY:", acceptText);

    if (!acceptRes.ok) {
      activeCalls.delete(callId);
      return;
    }

    activeCalls.set(callId, {
      ...activeCalls.get(callId),
      accepted: true
    });

    // 2) accepted call websocket 연결
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    activeCalls.set(callId, {
      ...activeCalls.get(callId),
      ws
    });

    let sessionReady = false;

    ws.on("open", () => {
      console.log("Realtime websocket connected for call:", callId);

      // 3) 세션 성격만 짧게 업데이트
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: "gpt-realtime",
            instructions: `
You are Alex from Ringmate.

Talk like a real person.
Stay calm, mature, brief, and natural.
Never sound scripted.
Use short sentences.
Ask one question at a time.
Pause and wait after each question.
Acknowledge briefly before moving on.
Do not over-explain.
Do not become pushy.
If they are interested, suggest a human follow-up.
            `
          }
        })
      );
    });

    const sendOpening = () => {
      const state = activeCalls.get(callId);
      if (!state || state.openerSent || !sessionReady) return;

      state.openerSent = true;
      activeCalls.set(callId, state);

      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking now.

Use this opening style:
calm, confident, natural, brief.

Say:
"Hi, this is Alex with Ringmate... quick question."

Then ask:
"Are you the one handling calls over there?"

Then stop and wait for their answer.
            `
          }
        })
      );
    };

    ws.on("message", (data) => {
      const text = data.toString();
      console.log("Realtime event:", text);

      try {
        const msg = JSON.parse(text);

        if (
          msg.type === "session.updated" ||
          msg.type === "session.created"
        ) {
          sessionReady = true;
          sendOpening();
        }

        if (msg.type === "error") {
          console.error("Realtime error event:", JSON.stringify(msg, null, 2));
        }
      } catch (err) {
        console.error("Failed to parse realtime message:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("Realtime websocket error:", err);
    });

    ws.on("close", () => {
      console.log("Realtime websocket closed for call:", callId);
      activeCalls.delete(callId);
    });

    // safety cleanup
    setTimeout(() => {
      if (activeCalls.has(callId)) {
        console.log("Cleaning up stale call:", callId);
        try {
          activeCalls.get(callId)?.ws?.close();
        } catch {}
        activeCalls.delete(callId);
      }
    }, 10 * 60 * 1000);
  } catch (error) {
    console.error("Webhook error:", error);
    if (!res.headersSent) {
      res.status(500).send("error");
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
