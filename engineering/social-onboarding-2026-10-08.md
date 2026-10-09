# People: a useful first connection

People owns conversations with people in other GSV spaces, incoming message
requests, and the private address book. A first visit should answer what this
enables, whom to connect with, and how to start. An established user should see
who needs a reply and get back to their conversation immediately.

The first-use surface introduces talking directly and asking Ship to coordinate
something together. Concrete, selectable examples lead into the same connection
flow as the ordinary Connect action. Invitations are shareable links; existing
codes remain accepted. Managed installations reuse the existing Accounts space
chooser, then the recipient's normal space login and explicit acceptance. Every
invitation entry point also accepts a space address, including spaces owned by
someone else or served by another operator. No public profile is required.
Public profiles remain an alternative for reaching someone by address.

Acceptance opens the resulting conversation. A task chosen before connecting
remains available afterward. Ask Ship opens an editable draft in the user's
ordinary Ship conversation with the contact identified; the user sends it.
Each person explicitly chooses who handles new messages before inviting or
accepting. Neither option is preselected. Kernel retains that local choice with
the invitation or request, and applies it when pairing completes. Ship can create
and accept invitations in the ordinary conversation after asking
for this choice, and can change it later at the owner’s request. The canonical
Ship uses the same Kernel authority and revision checks; delegated work cannot
change these settings. Connection alone does not start Ship or replay existing
messages. The conversation's
Automatically handle new messages setting changes the choice later; replies to
assigned tasks can still resume those tasks independently.

Keep Instrument's list/detail layout, typography, thin rules, and quiet text
actions. The empty state must work on a narrow screen too. Incoming requests and
unread conversations are visible from the shared navigation and Zen, including
after reconnect or reload. Existing owner-scoped signals invalidate the existing
inbox and request queries; there is no new notification service or polling loop.

Kernel owns invitation verification, contact authority, and unread selection.
Accounts owns choosing an existing space. Instrument owns presentation and view
launches. Invitations stay out of request URLs and telemetry by travelling in
fragments. Publication, permissions, credentials, and standing prompt text retain
their existing owners. Containers, a new CLI, a public directory, group chat, and
changes to agent isolation are outside this change.

Validate the shared invitation format and inbox selection at their boundaries,
the web connection and navigation transitions, and a fresh two-space connection,
message, acceptance and reload flow. Inspect light, dark, and narrow layouts.

## People while talking to Ship

Zen keeps one compact People line above its composer. Incoming messages do not
become moving entries in the Ship transcript and never force its scroll position.
The line combines live notices, unread conversations recovered after reload,
incoming requests and unfinished replies. A selected person opens one bounded
panel above the line, with their messages, a reply field and a link to People.
Closing the panel keeps the draft. Replying clears the answered messages; arrivals
during a send remain waiting. The panel does not open itself for new messages.

Instrument owns this presentation, using the existing inbox, conversation history,
signals and reply intents. People retains the full conversation and request
workflow. Form placeholders share the Zen prompt's typographic treatment across
Instrument instead of falling back to native gray placeholders.
