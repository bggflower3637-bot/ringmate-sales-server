import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("OpenAI Realtime webhook server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    // OpenAI 쪽에는 먼저 바로 응답
    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") {
      return;
    }

    const callId = event?.data?.call_id;
    if (!callId) {
      console.log("No call_id found");
      return;
    }

    const response = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          instructions: `
You are Alex from Ringmate.

IMPORTANT:
- Start speaking immediately as soon as the call connects.
- Do NOT wait for the user to speak first.
- Keep responses short, natural, and conversational.
- Sound like a real human, not a script or robot.
- Use a warm, confident, casual tone.
- Add slight natural pauses.
- Do not give long explanations.
- Ask only one short question at a time.

GOAL:
- Start the conversation naturally.
- Find out whether they are handling calls manually.
- Keep the interaction smooth and human-like.

OPENING:
Start with this exact style:
"Hey — this is Alex from Ringmate... quick question."

Then continue naturally, for example:
"Are you the one handling calls over there?"
or
"Are you still handling incoming calls manually right now?"

STYLE RULES:
- Short sentences.
- No corporate jargon.
- No long monologues.
- No bullet-point sounding speech.
- Speak like a calm, experienced human caller.
- If the user responds, acknowledge briefly before asking the next question.
- Never sound overly salesy in the first few seconds.
          `
        })
      }
    );

    const text = await response.text();
    console.log("ACCEPT STATUS:", response.status);
    console.log("ACCEPT BODY:", text);

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
