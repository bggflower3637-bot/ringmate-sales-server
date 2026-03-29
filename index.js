import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

const activeCalls = new Map();

app.get("/", (req, res) => {
  res.send("OpenAI Realtime webhook server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    // OpenAI webhook에는 바로 응답
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

    activeCalls.set(callId, { startedAt: Date.now() });

    // 1) call accept
    const acceptRes = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",

          // voice는 여기: audio.output.voice
          audio: {
            output: {
              voice: "cedar"
            }
          },

          instructions: `
You are Alex from Ringmate.

VOICE & DELIVERY
- Use a calm, mature, grounded, slightly warm tone.
- Speak at a moderate pace.
- Do not speak too fast.
- Sound confident, natural, and human.
- Never sound robotic or overly cheerful.
- Use short sentences and brief natural pauses.

CONVERSATION STYLE
- This is a real business phone call.
- Start naturally, not like a telemarketer script.
- Do not jump into a hard sales pitch immediately.
- Ask only one short question at a time.
- After the other person answers, briefly acknowledge them, then continue.
- Keep the flow conversational and easy to follow.
- No long monologues.
- No corporate jargon.
- No bullet-point sounding speech.

GOAL
- Find out whether they are still handling calls manually.
- Learn whether missed calls or call volume are creating problems.
- If they show interest, offer to have a real team member follow up.
- If they are not interested, end politely and briefly.

IMPORTANT
- Begin speaking immediately when the call connects.
- Do NOT wait for the other person to speak first.
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

    // 2) accepted call에 websocket 연결
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    activeCalls.set(callId, {
      ...activeCalls.get(callId),
      ws
    });

    ws.on("open", () => {
      console.log("Realtime websocket connected for call:", callId);

      // 3) 첫 멘트 강제 생성
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking immediately.

FIRST TURN RULES
- Sound natural and calm.
- Do not rush.
- Do not sound pushy.
- Keep the opener short.
- Speak in the same calm, mature cedar voice and moderate pace.

OPENING
Start like this:
"Hi, this is Alex with Ringmate... quick question."

Then ask one short question:
"Are you the one handling calls over there?"

After that, stop and let them answer.
            `
          }
        })
      );
    });

    ws.on("message", (data) => {
      console.log("Realtime event:", data.toString());
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

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
