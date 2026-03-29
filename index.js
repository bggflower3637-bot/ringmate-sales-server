import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

// Optional: keep a small in-memory map to avoid duplicate websocket launches
const activeCalls = new Map();

app.get("/", (req, res) => {
  res.send("OpenAI Realtime webhook server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    // Reply to OpenAI immediately
    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") {
      return;
    }

    const callId = event?.data?.call_id;
    if (!callId) {
      console.log("No call_id found");
      return;
    }

    // Prevent duplicate handling of the same call_id
    if (activeCalls.has(callId)) {
      console.log("Call already being handled:", callId);
      return;
    }

    activeCalls.set(callId, { startedAt: Date.now() });

    // 1) Accept the call
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
          voice: "cedar",
          instructions: `
You are Alex from Ringmate.

VOICE & DELIVERY
- Use the built-in voice "cedar".
- Speak at a moderate pace.
- Do not speak too fast.
- Sound calm, mature, grounded, and confident.
- Sound like a real person on a phone call.
- Slightly warm, slightly professional, never robotic.
- Keep your sentences short and easy to follow.
- Use brief natural pauses.
- Do not sound overly cheerful or lightweight.

CONVERSATION STYLE
- This is a real outbound business call.
- Start naturally, not like a script.
- Do not jump straight into a hard sales pitch.
- Build a little rapport first.
- Ask only one short question at a time.
- After the other person answers, give a short natural acknowledgment before the next question.
- Examples of acknowledgment style: "Got it.", "Okay, I see.", "Makes sense.", "Sure."
- Never give long monologues.
- Never sound like a bullet-point presentation.
- Never use corporate jargon.
- Never sound pushy in the first part of the call.

PRIMARY GOAL
- Find out whether they are handling calls manually.
- Learn whether missed calls or call volume are affecting them.
- If there is interest, offer to have a real person follow up.
- Do not try to close aggressively on the call.

HANDOFF RULE
- If they sound interested, curious, or open to learning more, say that a team member can follow up with more detail.
- Do not over-explain the product before confirming interest.

IF NOT INTERESTED
- Stay polite and brief.
- End cleanly without pressure.

IMPORTANT
- Begin speaking immediately when the call connects.
- Do NOT wait for the user to speak first.
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

    // 2) Connect websocket to the accepted realtime call
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

      // 3) Force the first spoken turn immediately
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking immediately.

FIRST TURN RULES
- Start naturally and calmly.
- Do not sound like a telemarketer.
- Do not rush.
- Keep the opener short.

OPENING EXAMPLE STYLE
Say something in this style:
"Hi, this is Alex with Ringmate... quick question."

Then continue naturally with one short question:
"Are you the one handling calls over there?"
or
"Are you still handling incoming calls manually right now?"

After that, stop and let them respond.
            `
          }
        })
      );
    });

    ws.on("message", (data) => {
      const text = data.toString();
      console.log("Realtime event:", text);
    });

    ws.on("error", (err) => {
      console.error("Realtime websocket error:", err);
    });

    ws.on("close", () => {
      console.log("Realtime websocket closed for call:", callId);
      activeCalls.delete(callId);
    });

    // Safety cleanup in case close never fires
    setTimeout(() => {
      if (activeCalls.has(callId)) {
        console.log("Cleaning up stale call:", callId);
        try {
          activeCalls.get(callId)?.ws?.close();
        } catch {}
        activeCalls.delete(callId);
      }
    }, 1000 * 60 * 10); // 10 minutes

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
