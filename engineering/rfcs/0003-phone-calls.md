# RFC 0003: Phone Calls

Status: **proposed**

## Summary

Ship can place a phone call for its owner: book a table, ask a shop whether
something is in stock, move an appointment. Ship does not talk on the call
itself. It writes a brief, and a specialized voice agent in an optional calls
service places the call, keeps to the brief, asks when something falls outside
it, and reports back.

```text
 Owner: "book a table at Lúa for Friday, four people"
   │
   ▼
 Ship (Process) ── writes the brief, keeps the promise in r12y
   │  phone.call {to, brief}                          approval: ask
   ▼
 Kernel ── authorize · approval · entitlement · route
   │  PHONE service binding (optional, operator-owned)
   ▼
 workers/calls ── call Durable Object: one call, one lease
   │   ├─ Twilio: PSTN leg + bidirectional media stream (8 kHz μ-law)
   │   └─ realtime speech-to-speech model, instructed only by the brief
   │        │
   │        ├─ ask ──► Kernel ──► ship event phone.asked ──► Ship ──► owner
   │        │   "they only have 21:30, take it?"      the agent keeps the line
   │        └─ end_call {outcome, summary}
   ▼
 ship event phone.ended {outcome, summary, transcript}
   → Ship settles the responsibility and tells the owner: "Booked, 21:30"
```

The owner can follow the call live, answer questions, steer the agent with a
typed note, end the call, or take it over with their own voice.

## Why a separate voice agent

A phone conversation needs replies within about half a second. A Process run is
turn-based: a generation, tool calls, results, another generation. It cannot hold
a live conversation, and it should not try: the Gateway is a control plane, and
heavy or platform-native computation belongs in a specialized service.

The brief is what makes this safe. The voice agent does not get Ship's context,
memory, tools or targets. It gets one goal, what it may say, what it must not
agree to, and a way to ask. Everything beyond that goes back to Ship.

Speech-to-speech models are built for this latency. A pipeline of transcription,
a text model and synthesis waits on each stage every turn. The calls service
therefore speaks to a realtime model directly and keeps a model-neutral interface
(audio in; audio, transcript and tool calls out), so a different provider or an
open model can replace it without changing Ship, the syscalls or clients.

## Ownership

| Component | Owns |
| --- | --- |
| Ship and delegated Processes | Deciding to call, writing the brief, answering questions, settling the responsibility and telling the owner. |
| Kernel | Owner and installation identity, authorization, approval, the `phone.*` syscalls, ship events, writing the transcript file, signals to clients. |
| `workers/calls` (optional) | Call records and leases, entitlement admission and usage, number selection, the Twilio leg, the realtime session, the voice agent's tools, the opening disclosure, take-over, and cleanup. |
| `workers/inference` | The realtime provider credential. It mints a short-lived session credential for one call; the long-lived key never reaches the calls service. |
| Instrument (web, Desktop) | The call card: live transcript, question, note, End, Take over. |

The contract follows the [cloud instances](../cloud-instances.md) pattern: an
optional installation-scoped service under `packages/gsv/src/services/phone.ts`,
acquired with `getInstallation(installationId)` from a trusted Gateway binding.
The Kernel supplies the owner and acting Process; public arguments cannot choose
an installation, owner, caller ID or provider account. The service reports
changes back through a deployment-authorized `PhoneGatewayService` carrying
identity and revisions, and the Kernel rejects stale revisions and callbacks for
another installation or a call already terminal.

## The brief

Ship writes the brief; the owner sees it in the approval.

```yaml
to: "+34 910 000 000"
business: "Restaurante Lúa"              # how the agent addresses the callee
on_behalf_of: Esteve Jamez               # the name in the opening line
goal: Reserve a table for 4 on Friday 31 October, around 21:00
may_share:                               # facts the agent may say
  - The reservation name is Esteve
must_not:                                # limits the agent never crosses
  - give card or payment details
  - agree to a deposit
  - accept a time before 20:30 or after 22:00
if_outside_limits: ask                   # ask | end
voicemail: hang_up                       # hang_up | leave_message
language: es                             # optional; otherwise the agent follows the callee
max_minutes: 6                           # capped by the entitlement
```

`phone.call` validates the brief structurally and bounds every field. It does not
judge whether a goal is sensible; that is the owner's approval.

Ship fills `on_behalf_of` from the owner's profile or memory, so the name
callees hear is part of what the owner approves; there is no separate setting.
The voice agent's instructions are rendered by the Kernel from a template in
`workers/gateway/src/prompts/phone/` and the brief.
The template is production prompt text and follows the protected-prompt rules.

## Calls and the voice agent

### One call, one lease

`phone.call` creates one call record with a fresh `callId` and returns it at
once. One call Durable Object, named by installation and call, owns the lease. A
call is never replayed: if anything fails after dialling begins, the call ends
with an outcome and Ship decides what to do next. The Durable Object is created
with a location hint for the destination's region so its two WebSockets stay
close to Twilio's media edge.

```text
 queued ─► dialling ─► ringing ─► in_progress ──► ended
                         │            │   ▲
                         │            ▼   │ answer / note
                         │          asking
                         │            │ owner joins
                         │            ▼
                         │        taken_over ───► ended
                         └─► ended (busy · no_answer · failed · voicemail)
```

Outcomes: `completed`, `callback_needed`, `owner_took_over`, `busy`,
`no_answer`, `voicemail`, `ended_by_owner`, `refused`, `dropped`, `failed`.
`completed` and `callback_needed` carry the agent's summary.

### Media path

Twilio connects the answered call to the call Durable Object with a bidirectional
Media Stream. The Durable Object opens one WebSocket to the realtime model with
the session credential from inference and relays audio both ways in the
telephony format. Audio is held only in memory while relayed.

### Opening and disclosure

The first sentence of every call says who the call is for and that the caller is
an AI assistant, as half a sentence inside the actual request rather than a
preamble:

> Hi! I'm calling for Esteve, I'm his AI assistant. Could I order delivery for
> two pepperoni pizzas?

The model words it naturally in the call's language; the template makes it a
rule. The service records, as a boolean outcome field, whether the first
response named the owner and an assistant, so tests and review can catch a
template that stops doing it. This meets the EU AI Act's transparency duty (Article 50, in
force since 2 August 2026) without a formal script. The agent never claims to
be human and answers truthfully if asked. The opening does not mention
transcription, and does not say "Ship": a product name means nothing to the
callee.

### Agent tools

The voice agent has exactly three tools:

| Tool | Effect |
| --- | --- |
| `ask(question)` | Puts the call in `asking` and sends `phone.asked` to Ship. The agent tells the callee it is checking. |
| `end_call(outcome, summary)` | Says goodbye and hangs up. |
| `keypad(digits)` | Sends DTMF tones to navigate a phone menu. |

### Questions during the call

```text
 voice agent ── ask("only 21:30 free, take it?") ──► calls DO
                                                       │ phoneChanged(asking)
                                                       ▼
 Kernel ── ship event phone.asked ──► Ship wakes
   │                                    ├─ knows the answer ─► phone.answer
   │                                    └─ asks the owner ──► owner replies
   │                                                           ─► phone.answer
   └─ owner's call card shows the question ──► owner answers ─► phone.answer
                                                       │
 voice agent ◄── answer as a session message ◄─────────┘
```

The deadline applies only while a question is open, never to ordinary turns,
which stay real time. It is 45 seconds by default. The agent says it is checking
when it asks, checks in about every 15 seconds ("still checking, thanks for
waiting"), and offers to call back sooner if the callee needs to go. If no answer
arrives, the agent says it will call back and ends the call with
`callback_needed`. Ship then records the
follow-up in r12y. Whichever answer arrives first wins; later answers for the
same question are rejected.

### Live view, notes, ending and take-over

- `phone.watch` returns a body stream of transcript lines and state changes for
  one call, like `browser.watch`. Closing it never affects the call.
- `phone.note` sends a typed note into the live session ("say Saturday also
  works"). It reaches the model as an instruction, never spoken verbatim.
- `phone.end` ends the call at once (`ended_by_owner`). `proc.abort` and
  cancelling the run do not hang up a call already dialled; the call is
  explicit work, like a durable shell session.
- `phone.join` lets the owner take over. The service mints a short-lived Twilio
  Voice access token for one client identity bound to that call; the browser or
  Desktop connects its microphone through the Twilio Voice SDK; the service then
  redirects the live call from the media stream to that client. The realtime
  session closes and the transcript stops at the take-over. Take-over is one way.

## Syscalls

| Syscall | Caller | Result |
| --- | --- | --- |
| `phone.call` | Ship, delegated Processes, owner | `{ callId, state }` |
| `phone.get` / `phone.list` | owner and the calling Process | Call record: state, brief, outcome, summary, transcript reference |
| `phone.answer` | owner, Ship | Answers the open question |
| `phone.note` | owner, Ship | Sends a note into the live session |
| `phone.end` | owner, the calling Process | Ends the call |
| `phone.watch` | owner | Live transcript stream |
| `phone.join` | owner, human sessions only | Take-over credential |

Shell and CodeMode reach them through a `phone` command in the native `gsv`
target (`phone call --brief brief.yaml`, `phone answer <callId> "yes, 21:30"`).
No model tool is added. `phone.*` is a `gsv`-only domain backed by the optional
`PHONE` binding; without the binding the domain is unavailable and the command
says so.

## Authorization and approval

- `phone.call` gets a default approval rule of **ask**, alongside `mail.send`
  and `atproto.write`. The approval shows the number, the business and the brief.
- There is no "always allow" for calls in the first release. Each call has its
  own brief, so allowing a number would approve briefs the owner never saw; the
  approval is also the owner's review of what will be said in their name.
- Every other `phone.*` syscall acts on an existing call owned by the same human
  and needs no approval.
- Schedules that would place a call need their own approval.
- `phone.join` requires an interactive human session, never a Process or adapter.

## Numbers and callbacks

Calls use a small operator-owned pool of numbers, one per region, chosen by the
destination's country. There are no per-Ship numbers. The first release has one
US number; a Spanish number is added when its regulatory bundle is approved, and
calls to Spain and nearby countries switch to it.

Until inbound calls ship, the pool numbers answer with a short recorded message
explaining that they place calls for Ship assistants and cannot receive calls.

## Records and privacy

- **No audio recording.** Provider-side recording is off, and the realtime
  provider's data retention is the shortest the account allows.
- **The transcript is the record.** The Kernel writes it as a file under the
  Ship account's home (`~/calls/<date>-<callId>.md`) and links it from the
  `phone.ended` event, with the brief, outcome and summary.
- The service keeps call records and transcripts only until the Kernel
  acknowledges `phone.ended`, then keeps the call record without the transcript
  for usage and abuse review.
- Telemetry records timings, state transitions, outcomes, durations and costs,
  never numbers, transcripts or briefs.

## Admission, abuse and usage

Entitlements, read by the service through the existing `EntitlementCache`:

| Key | Early access default | Meaning |
| --- | --- | --- |
| `phone.enabled` | `false`, enabled per Ship by override | Calls are available |
| `phone.concurrent_calls` | `1` | Calls in progress at once |
| `phone.daily_calls` | `10` | Calls started per day |
| `phone.max_call_seconds` | `360` | Hard cap per call |

The service also enforces:

- Emergency numbers, short codes and premium-rate numbers are refused before
  dialling. Twilio's high-risk permissions stay off.
- Only countries the operator allows can be called.
- Only `active` installations can place calls. A call already in progress when
  an installation becomes `restricted` runs to its end.
- The service reserves minutes before dialling and settles from the Twilio
  duration and the realtime usage the session reports.

## Ship events

Two new ship event kinds join `contact.message` and `owner.notified`:

- `phone.asked {callId, questionId, question, deadlineAt}` wakes Ship at once.
- `phone.ended {callId, outcome, summary, transcriptPath}` wakes Ship to settle
  the work.

State changes in between reach clients as signals and do not wake Ship.

## Delivery plan

1. **Contract:** `packages/gsv/src/services/phone.ts`, the `phone.*` syscall
   types, the two ship event kinds.
2. **Calls service:** `workers/calls` with the call Durable Object, Twilio leg,
   realtime relay, three agent tools, entitlement admission and a fake provider
   for tests. Inference mints realtime session credentials.
3. **Kernel:** syscalls, approval default (next Kernel migration), ship events,
   transcript files, the `phone` shell command.
4. **Instrument:** the call card in Chat with transcript, question, note, End
   and Take over.
5. **Operator:** the `PHONE` binding, Twilio and model secrets, the pool number
   and allowed countries, and the entitlement keys in the early-access plan
   (services repository).
6. **Docs:** a how-to for calls, the syscall reference, and the GSV Manual.

Inbound calls (callbacks routed to the Ship that last called that number, and
an owner calling their own Ship) are a later RFC.

## Invariants

- One `phone.call` places at most one call. Nothing redials automatically.
- The voice agent knows only the brief, answers and notes.
- Every call's first sentence names the owner and says the caller is an AI assistant.
- No audio is stored.
- A question gets exactly one answer, or the deadline.
- A terminal call never changes state again; late provider callbacks are
  ignored.
- Cancelling a run never hangs up a call; only `phone.end`, the agent, the
  callee or the time cap end it.

## Decisions

1. **Realtime provider:** OpenAI Realtime, which is expected to take telephony
   μ-law audio directly. The interface stays model-neutral.
2. **Question deadline:** 45 seconds, only while a question is open, with
   check-ins every 15 seconds.
3. **Approval:** every call asks; no "always allow" in the first release.
4. **Name in the opening:** `on_behalf_of` in the approved brief.
5. **Disclosure:** one natural clause in the first sentence ("I'm calling for
   Esteve, I'm his AI assistant"). Transcription is not announced; revisit for
   California before calling there, where AI transcription by a third party is
   being litigated as interception.

## Open questions

1. **Keypad.** Twilio's bidirectional streams may not carry DTMF; sending tones
   could require briefly redirecting the call. Confirm during the build.

## Non-goals

- Inbound calls and per-Ship numbers.
- Calls placed without an owner's approval or rule.
- Bulk calling, marketing or outreach.
- Storing call audio.
- Giving the voice agent access to Ship's tools, memory or targets.
