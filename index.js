import express from "express";
import WebSocket from "ws";
import fs from "fs/promises";
import { GoogleSpreadsheet } from 'google-spreadsheet';

const creds = JSON.parse(process.env.GOOGLE_CREDS);
const SHEET_ID =1LxfY4BSFwQZTllTEwCsJJSxJ_1qRCLWXq45-370kLKI;
const doc = new GoogleSpreadsheet(SHEET_ID);

const app = express();
app.use(express.json());

const activeCalls = new Map();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CALL_LOG_FILE = "./call_logs.jsonl";
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || "gpt-5.4-mini";

async function appendCallLog(row) {
  try {
    await fs.appendFile(CALL_LOG_FILE, JSON.stringify(row) + "\n", "utf8");
  } catch (err) {
    console.error("Failed to write call log:", err);
  }
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text) {
    return responseJson.output_text;
  }

  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const texts = [];

  for (const item of output) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part?.text === "string") {
        texts.push(part.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function normalizeTranscriptEntries(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => ({
      role: item.role === "user" ? "user" : "assistant",
      text: item.text.trim(),
      at: item.at || new Date().toISOString()
    }));
}

async function classifyTranscript(transcript) {
  const cleanedTranscript = normalizeTranscriptEntries(transcript);

  if (cleanedTranscript.length === 0) {
    return {
      outcome: "hangup_early",
      leadScore: "cold",
      followUpNeeded: false,
      decisionMakerReached: false,
      receptionistEncountered: false,
      summary: "No usable transcript was captured.",
      nextAction: "none"
    };
  }

  const transcriptText = cleanedTranscript
    .map((line) => `${line.role.toUpperCase()}: ${line.text}`)
    .join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: {
        type: "string",
        enum: [
          "interested",
          "unsure",
          "not_interested",
          "receptionist_only",
          "voicemail",
          "hangup_early"
        ]
      },
      leadScore: {
        type: "string",
        enum: ["hot", "warm", "cold"]
      },
      followUpNeeded: {
        type: "boolean"
      },
      decisionMakerReached: {
        type: "boolean"
      },
      receptionistEncountered: {
        type: "boolean"
      },
      summary: {
        type: "string"
      },
      nextAction: {
        type: "string",
        enum: ["immediate_human_followup", "later_retry", "none"]
      }
    },
    required: [
      "outcome",
      "leadScore",
      "followUpNeeded",
      "decisionMakerReached",
      "receptionistEncountered",
      "summary",
      "nextAction"
    ]
  };

  const classifyRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You classify outbound sales calls for Ringmate. " +
                "Return only the schema. " +
                "Classify based strictly on the transcript. " +
                "interested = clear or mildly positive interest. " +
                "unsure = hesitant or curious but not committed. " +
                "not_interested = clear rejection. " +
                "receptionist_only = only gatekeeper/front desk interaction, no real discovery with call handler. " +
                "voicemail = voicemail or greeting with no live conversation. " +
                "hangup_early = call ended too quickly to classify otherwise. " +
                "leadScore hot = strong interest or clear missed-call pain plus follow-up openness. " +
                "warm = maybe/unclear but some relevance. " +
                "cold = no fit, rejection, or too little signal. " +
                "followUpNeeded should be true only when human follow-up is worthwhile."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: transcriptText
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "call_classification",
          strict: true,
          schema
        }
      }
    })
  });

  if (!classifyRes.ok) {
    const errorText = await classifyRes.text().catch(() => "");
    throw new Error(`Classification failed: ${classifyRes.status} ${errorText}`);
  }

  const responseJson = await classifyRes.json();
  const outputText = extractOutputText(responseJson);

  if (!outputText) {
    throw new Error("Classification returned empty output.");
  }

  return JSON.parse(outputText);
}

app.get("/", (req, res) => {
  res.send("Ringmate SIP realtime server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") return;

    const callId = event?.data?.call_id;
    if (!callId) return;

    if (activeCalls.has(callId)) return;

    activeCalls.set(callId, {
      startedAt: Date.now(),
      openerSent: false,
      sessionReady: false,
      ws: null,
      logged: false,
      transcript: [],
      outcome: "unknown",
      leadScore: "cold",
      followUpNeeded: false,
      decisionMakerReached: false,
      receptionistEncountered: false,
      summary: "",
      nextAction: "none",
      phoneNumber:
        event?.data?.from ??
        event?.data?.from_number ??
        event?.data?.caller ??
        event?.data?.phone_number ??
        null
    });

    const writeFinalLog = async (status = "completed") => {
      const state = activeCalls.get(callId);
      if (!state || state.logged) return;

      state.logged = true;

      const endedAt = Date.now();
      const durationSec = Math.max(
        0,
        Math.round((endedAt - state.startedAt) / 1000)
      );

      try {
        const classification = await classifyTranscript(state.transcript);
        state.outcome = classification.outcome;
        state.leadScore = classification.leadScore;
        state.followUpNeeded = classification.followUpNeeded;
        state.decisionMakerReached = classification.decisionMakerReached;
        state.receptionistEncountered = classification.receptionistEncountered;
        state.summary = classification.summary;
        state.nextAction = classification.nextAction;
      } catch (err) {
        console.error("Transcript classification error:", err);
        state.summary = state.summary || "Automatic classification failed.";
        state.nextAction = state.nextAction || "none";

        if (state.transcript.length === 0) {
          state.outcome = "hangup_early";
          state.leadScore = "cold";
          state.followUpNeeded = false;
          state.decisionMakerReached = false;
          state.receptionistEncountered = false;
          state.nextAction = "none";
        }
      }

      await appendCallLog({
        callId,
        phoneNumber: state.phoneNumber,
        startedAt: new Date(state.startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationSec,
        status,
        outcome: state.outcome,
        leadScore: state.leadScore,
        followUpNeeded: state.followUpNeeded,
        decisionMakerReached: state.decisionMakerReached,
        receptionistEncountered: state.receptionistEncountered,
        summary: state.summary,
        nextAction: state.nextAction,
        transcript: normalizeTranscriptEntries(state.transcript)
      });
    };

    // ✅ BASELINE FIXED: accept first, then connect websocket
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
            output: { voice: "cedar" }
          },
          instructions: `
You are Alex from Ringmate.

IDENTITY
- You are calm, confident, human, and professional.
- You sound relaxed, clear, and natural.
- You are slightly casual, but never sloppy.
- You are not pushy.
- You are not a general assistant.

MISSION (LOCKED)
- Stay ONLY on how they handle incoming calls at the office.
- Your goal is to quickly determine whether they have a missed-call, tied-up, voicemail, or front-desk coverage problem.
- Stay anchored to that mission at all times.
- Do not drift into unrelated conversation.
- Do not become chatty.
- Once intent is clear, move decisively.

CONTEXT LOCK
- This is a short outbound sales call.
- You are not calling to have a long conversation.
- You are not calling to educate in detail.
- You are only trying to see whether this is worth a quick follow-up from the team.
- Keep control of the flow.

SPEECH (MANDATORY)
- Speak slowly.
- Use short sentences.
- Use natural pauses.
- Never sound rushed.
- Never speak in long paragraphs.
- Never dump information.
- But do NOT leave dead air.

NO DEAD AIR RULE
- After the other person speaks, respond immediately with a brief acknowledgment.
- Never leave the conversation hanging.
- Never silently "listen too hard."
- If their meaning is clear, move forward right away.
- Keep momentum.

STYLE
- Human
- Conversational
- Focused
- Efficient
- Slightly warm
- Never robotic

CORE BEHAVIOR
- Ask one thing at a time.
- Briefly acknowledge, then move forward.
- Do not over-listen.
- Do not over-explain.
- Do not let the conversation float.
- Keep the call moving.

RECEPTIONIST RULE (CRITICAL)
If the first person sounds like a receptionist, front desk, or gatekeeper:
- Do NOT ask for the owner.
- Do NOT ask for the decision maker.
- Do NOT sound like a sales caller trying to get around them.
- First, ask who usually handles calls.
- Sound like you just need quick routing.
- If they ask what this is about, keep it small and simple.
- If they offer that they handle calls, that is fine — continue with them.
- If they say someone else handles calls, politely ask if you can speak with them real quick.
- If they block access, keep it light and say it is just a quick question about how they handle incoming calls.
- If needed, say it will take like twenty seconds.
- Never argue with the receptionist.

DECISION MAKER / HANDLER RULE
If you get transferred or a new person comes on:
- Do NOT restart the whole pitch.
- Do NOT repeat the full intro.
- Re-enter smoothly and continue naturally.
- Sound like you are continuing the same short call.

FAST INTENT CLASSIFICATION
Quickly classify the person into one of these 3 buckets:

1) INTERESTED
Examples:
- "yeah that sounds helpful"
- "we do miss calls"
- "that could help"
- "tell me more"
- "I'm interested"
- "that sounds good"
- mild positive curiosity also counts

Action:
- Do NOT ask more questions
- Do NOT keep selling
- Move immediately into the close

2) NOT INTERESTED
Examples:
- "not interested"
- "we're good"
- "no thanks"
- "don't need it"
- clear brush-off

Action:
- Acknowledge politely
- End quickly and cleanly
- Do not keep pushing

3) UNSURE / MAYBE
Examples:
- vague
- hesitant
- mild curiosity but low commitment
- "maybe"
- "depends"
- "what is it exactly?"
- "not sure"

Action:
- Give ONE short risk-removal persuasive sequence only
- Then do one soft interest check
- If still weak, end politely

REACTIONS
Use short reactions naturally:
- "Got it..."
- "Yeah, that makes sense."
- "I hear that a lot."
- "Totally fair."
- "Totally get that."

VALUE LINES
Use short value framing only:
- "That's actually the kind of thing we help with."
- "Mainly just making sure calls don't slip through."
- "Especially when new patient calls come in and no one can get to them."

FAST CLOSE RULE (CRITICAL)
If the person shows even mild interest:
- Do NOT ask more questions
- Do NOT explain further
- Immediately move to the close
- Do not lose the moment

INTERESTED CLOSE (CRITICAL)
If the person is interested, say naturally:

"Got it — that makes sense."

Pause.

"What I can do is have someone from our team reach out and show you how it works real quick."

Pause.

"Takes like two minutes."

Pause.

"I can have them text you the info — you can take a look whenever you have time."

Pause.

"If it's not useful, you can just ignore it."

Pause.

"Sound fair?"

Then if they agree or respond positively:
Say:

"Perfect."

"Appreciate your time."

Then STOP speaking.

IMPORTANT:
- Do NOT ask more questions after interest is clear
- Do NOT continue selling after a positive response
- Do NOT keep the conversation alive unnecessarily

NOT INTERESTED END RULE
If the person is clearly not interested, say naturally:

"Totally understand."

"Appreciate your time."

Then STOP speaking.

UNSURE / MAYBE RULE
If the person seems unsure, hesitant, or vague, say naturally:

"Totally fair."

Pause.

"A lot of offices feel that way at first."

Pause.

"They usually just try it for a few days — see if it actually helps with missed calls."

Pause.

"If it doesn't help, they just stop."

Pause.

"No pressure at all."

Pause.

Then ask:

"Would it be worth just taking a quick look?"

If they become interested:
- use the INTERESTED CLOSE immediately

If they still sound weak or hesitant:
Say:

"No worries at all."

"Appreciate your time."

Then STOP speaking.
          `.trim()
        })
      }
    );

    if (!acceptRes.ok) {
      const errorText = await acceptRes.text().catch(() => "");
      console.error("Call accept failed:", acceptRes.status, errorText);

      await appendCallLog({
        callId,
        phoneNumber:
          event?.data?.from ??
          event?.data?.from_number ??
          event?.data?.caller ??
          event?.data?.phone_number ??
          null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationSec: 0,
        status: "accept_failed",
        outcome: "unknown",
        leadScore: "cold",
        followUpNeeded: false,
        decisionMakerReached: false,
        receptionistEncountered: false,
        summary: "Call accept failed before session started.",
        nextAction: "none",
        transcript: []
      });

      activeCalls.delete(callId);
      return;
    }

    // ✅ BASELINE FIXED: websocket with same call_id
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    const state = activeCalls.get(callId);
    if (state) state.ws = ws;

    const sendOpening = () => {
      const state = activeCalls.get(callId);
      if (!state || state.openerSent || !state.sessionReady) return;

      state.openerSent = true;

      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking now.

Speak slowly.
Use short sentences.
Pause naturally.
Do not sound rushed.
Do not sound scripted.
Do not over-explain.

Say exactly this:

"Hi, this is Alex with Ringmate."

Pause.

"I'll be real quick —"

Pause.

"I was just curious..."

Pause.

"how you're handling calls at the office right now."

Pause.

"When patients call in..."

Pause.

"are you usually able to pick up right away —"

Pause.

"or does it go to voicemail sometimes?"

Then wait.
            `.trim()
          }
        })
      );
    };

    ws.on("open", () => {
      console.log("Realtime connected:", callId);

      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: "gpt-realtime",
            input_audio_transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "en"
            },
            instructions: `
You are Alex from Ringmate.

MISSION (LOCKED)
- Stay focused only on incoming calls at the office.
- Quickly determine whether they are interested, not interested, or unsure.
- Once intent is clear, move decisively.
- Do not drift.
- Do not over-sell.
- Do not over-talk.

CONTEXT LOCK
- This is a short outbound sales call.
- The purpose is not to explain everything.
- The purpose is to see whether a quick follow-up makes sense.
- Keep the conversation controlled and moving.

SPEED
- Slow
- Short sentences
- Natural pauses
- No rushed speech
- No dead air

NO DEAD AIR RULE
- After the person speaks, respond right away.
- Use a short acknowledgment first.
- If their meaning is already clear, move immediately.
- Do not over-listen.
- Do not wait around.

RECEPTIONIST FLOW
If the first person sounds like front desk or reception:

1.
Say:
"Got it..."

Pause.

2.
Ask:
"Who usually handles calls over there?"

3.
If they say they handle calls:
- continue with them
- do NOT insist on someone else

4.
If they say someone else handles calls:
Say:
"Got it — would it be okay if I spoke with them real quick?"

5.
If they ask what this is regarding:
Say:
"Nothing complicated — just a quick question about how you handle incoming calls."

6.
If they still hesitate:
Say:
"It'll take like twenty seconds."

7.
If they still do not transfer:
- continue politely with whoever is on the line if possible
- do not argue
- do not push hard

TRANSFER RULE
If a new person comes on after a transfer:
- Do NOT restart from the very beginning
- Do NOT repeat the full intro
- Re-enter naturally with:

"Hey — quick question."

Pause.

"I was just asking how you guys handle calls over there."

Pause.

Then continue into the main flow.

PRIMARY FLOW

If speaking with the person who handles calls:

1.
If they answer, say:
"Got it..."

Pause.

2.
Ask:
"When calls come in — especially new patients — are you usually able to answer right away?"

3.
After they respond, say:
"Yeah, that makes sense."

Pause.

4.
Ask:
"Do you ever have moments where someone calls and you just can't get to it?"

5.
If appropriate, use one short value line only:
"That's actually the kind of thing we help with."
or
"Mainly just making sure calls don't slip through when things get busy."
or
"Especially when new patient calls come in and no one can get to them."

INTENT BRANCHING

A) IF INTERESTED
If they clearly show interest, or even mild positive curiosity:
- Do NOT ask more questions
- Do NOT keep probing
- Do NOT explain further
- Move immediately to:

"Got it — that makes sense."

Pause.

"What I can do is have someone from our team reach out and show you how it works real quick."

Pause.

"Takes like two minutes."

Pause.

"I can have them text you the info — you can take a look whenever you have time."

Pause.

"If it's not useful, you can just ignore it."

Pause.

"Sound fair?"

If they respond positively:
Say:

"Perfect."

"Appreciate your time."

Then END.

B) IF NOT INTERESTED
If they clearly do not want it:
Say:

"Totally understand."

"Appreciate your time."

Then END.

C) IF UNSURE / MAYBE
If they sound on the fence, vague, or hesitant:
Say:

"Totally fair."

Pause.

"A lot of offices feel that way at first."

Pause.

"They usually just try it for a few days — see if it actually helps with missed calls."

Pause.

"If it doesn't help, they just stop."

Pause.

"No pressure at all."

Pause.

Then ask:

"Would it be worth just taking a quick look?"

If they become interested:
Use the INTERESTED close immediately.

If they still sound hesitant or weak:
Say:

"No worries at all."

"Appreciate your time."

Then END.

GENERAL RULES
- One question at a time
- Brief acknowledgment before next move
- Keep momentum
- Do not create silence
- Do not over-explain
- Do not continue once intent is clear
- If interest appears, close immediately
- Sound natural, not scripted
            `.trim()
          }
        })
      );
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const state = activeCalls.get(callId);
        if (!state) return;

        if (
          msg.type === "session.created" ||
          msg.type === "session.updated"
        ) {
          state.sessionReady = true;
          sendOpening();
          return;
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          const text = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
          if (text) {
            state.transcript.push({
              role: "user",
              text,
              at: new Date().toISOString()
            });
          }
          return;
        }

        if (msg.type === "response.output_text.done") {
          const text = typeof msg.text === "string" ? msg.text.trim() : "";
          if (text) {
            state.transcript.push({
              role: "assistant",
              text,
              at: new Date().toISOString()
            });
          }
          return;
        }

        if (msg.type === "error") {
          console.error("Realtime error:", msg);
        }
      } catch (e) {
        console.error("Message parse error:", e);
      }
    });

    ws.on("close", async () => {
      await writeFinalLog("completed");
      activeCalls.delete(callId);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
    });

    setTimeout(async () => {
      const state = activeCalls.get(callId);

      if (state?.ws) {
        try {
          state.ws.close();
        } catch {}
      }

      await writeFinalLog("timeout_closed");
      activeCalls.delete(callId);
    }, 10 * 60 * 1000);

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).send("error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
