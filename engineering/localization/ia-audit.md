# Information architecture and terminology audit

> **Temporary.** This folder is working material for the localization effort. Delete it once the
> i18n work is complete; the glossary's decisions will by then be reflected in the product and the
> manual themselves.

Groundwork for offering Ship in several languages. Before translation keys exist, the vocabulary
and the hierarchy of concepts need to be settled, because every inconsistency in the source
language is multiplied per locale and every label the agent quotes to a person must match what the
person sees on screen.

| | |
|---|---|
| Date | 2026-10-20 |
| gsv | branch `localization-pre-work`, from `origin/main` 4a4cf996e |
| Ship Manual | pinned revision `0dd3147ef41eccb2315bfbfa3918188b74fe9f0c` (`workers/gateway/src/kernel/sys/manual-version.json`; manual PR #51, 2026-10-19). This is what installations import. |
| Companion files | `term-inventory.md` (every label, path:line, per surface), `gsv-traces.md` (every remaining "GSV", per surface, with a rerunnable count script) |

Paths are relative to the gsv repository root; `manual/...` paths are relative to the gsv-manual
repository root. Line numbers are as read on the date above.

## Scope and method

Six surfaces were inventoried in parallel by read-only passes using one shared schema
(concept · exact label · path:line · context · definition), then merged here.

| Surface | What was read | Depth |
|---|---|---|
| A. Ship Manual | all 36 pages at the pinned revision | full |
| B. Instrument web UI | `web/src/app`, `web/src/signup`, `web/src/desktop`, `web/index.html` | full (1580 rows) |
| C. Docs site | `docs/` (51 pages) and its VitePress config | sidebar, titles, definitions, GSV |
| D. Extension, adapters, Accounts | `extension/`, `workers/adapters/*`, `workers/installations/src` | user-readable text |
| E. Host apps | `host/apps/cli`, `host/apps/desktop`, `host/apps/machine`, packaging | help, errors, notices |
| F. Prompts, skills, man pages | `workers/gateway/src/prompts/**`, `skills/*/SKILL.md`, `drivers/native/man-pages.ts`, syscall tool descriptions | model-facing text the agent echoes |

Out of scope: the marketing site (separate repo), code identifiers, CSS, comments, tests. Prompt
content was read but is protected; nothing here proposes editing it without explicit authorization.

## Headline findings

1. **The interface and the manual use different trees for the same product, and both use two or
   more names for most things.** The manual is organised by outcome ("Talk with Ship and manage
   work", "Use your computers and browser"); the app is organised by five views (Chat, Fleet,
   Memory, People, Settings). Neither tree is wrong, but the manual's page titles never match the
   view names, so a person cannot go from a view to its manual page by name.
2. **"Ship" carries at least nine senses** across surfaces: the product, the agent, the
   conversation, the hosted instance, the desktop app, the CLI, the extension, the messenger bot
   and a model label. The hosted instance alone also goes by space, installation, gateway,
   deployment, registry, kernel and OS.
3. **The six most load-bearing nouns are each split three or more ways** (section 2): the
   connected machine (place / computer / machine / device / target), ongoing work (responsibilities /
   plans / ongoing / routines / schedules / standing), knowledge (memory / wiki / collections /
   instructions / context / knowledge), messaging (messengers / messaging connections / adapters /
   integrations / channels), the ledger (Logs / ledger / Activity / Syscall history, and "ledger"
   also means the responsibility store), and agents (Ship / helper / process / agent / Crew / worker).
4. **"GSV" is gone from the web app but is still the brand on four surfaces** (section 5): every
   messenger pairing reply, the machine daemon's update notices, the extension's page titles and
   most of the technical docs. The manual itself carries five sentences and the stale `gsv.space`
   domain.
5. **At the time of the audit, no surface had localization scaffolding.** Every string was an
   inline literal; `lang="en"` was hardcoded on every HTML page; the Settings rail printed raw ids
   as its labels; sentences were assembled from fragments on every surface; dates used `en-US` or
   the browser locale, never the owner's "Response language" preference (section 6). Since #475
   the web app has a catalog and runtime (see the section 6 addendum); the other surfaces still
   stand as described.

## 1. Concept map

### 1.1 What the manual says the product is made of

`manual/index.md` and `manual/pages/orientation.md` give the top-level model:

- **Ship**: the product, and "your continuing relationship with the personal intelligence"
  (orientation.md:28). Also defined circularly as "the main conversation with Ship" (index.md:66).
- **Messages vs Activity**: what was deliberately sent vs how work happened (orientation.md:38-39).
- **Work**: "a task with its own activity and controls" (index.md:67); shown as **Processes** in Fleet.
- **Send**: how Ship replies (index.md:70).
- **Target**: "a place where an action can run" (index.md:69); "The Web app calls connected targets
  **Places**." Three roles for connected technology: **surface**, **target**, **service**
  (orientation.md:53-55).
- **The ledger**: the record of every action (index.md:71), on a page titled "Logs".
- **Instrument**: the web app, with five views Chat · Fleet · Memory · People · Settings
  (orientation.md:30).

The heading "Four Useful Ideas" (index.md:64) introduces six bullets.

### 1.2 The manual's tree against the interface's tree

Manual sections (link text in `index.md` → section H1 → pages) alongside the app view each page
actually describes. Folder names are shown where they differ from the title, because the agent
reads pages by path.

| Manual section (link text → H1, folder) | Pages (H1, file) | App view(s) it describes |
|---|---|---|
| Meet Ship → "Meet Ship" (`orientation.md`, no folder) | – | all |
| Talk with Ship and manage work → "Talk With Ship And Manage Work" (`agents-assistants/`) | Messages, Work, And Delegation (`conversations-delegation.md`) · Identity, Context, Files, And Approvals · **Logs** (`ledger.md`) | Chat, Fleet › Processes, Settings › Logs |
| Work with files, memory, and skills → "Files, Memory, And Skills" (`files-knowledge/`) | Files, Paths, Copies, And Exact Revisions (`home-wiki-knowledge.md`, no wiki content) · Memory, Context, And Skills (`context-files-knowledge.md`) · Wikis And Repositories · Images, Audio, And Attachments | Memory, Settings › Instructions, Chat › + menu |
| Use your computers and browser → "Computers And Browser" (`devices-workplaces/`) | Run Commands And Copy Files Across Targets · Use A Browser Target · Use A Cloud Browser (linked as "Start a cloud browser and remember website logins") · Use A Cloud Computer | Fleet › Places, Chat place picker, Desktop "Connect this computer" |
| Use messaging, email, and connected services → "Messaging, Email, And Connected Services" (`integrations/`) | Connect And Route Messaging (`adapters-routing.md`) · Connect with another Ship (`contacts.md`) · Use Ship's Email Address · MCP And OAuth | Settings › Messengers, People, Settings › MCP servers |
| Schedule and delegate work → "Schedule And Delegate Work" (`automation/`) | Schedules, Queues, And Delegation (`schedules-processes-delegation.md`) | Chat › Plans › routines, Fleet › Processes |
| Manage accounts and permissions → "Accounts And Permissions" (`accounts-access/`) | Passwords, Sessions, Tokens, And People (`credentials-sharing.md`; linked three different ways) | Settings › Permissions, Settings › Sign-in, login |
| Change settings and recover from problems → "Settings And Recovery" (`settings/`) | Models, Voice, And Approvals (`ai-voice-approvals.md`) · Sessions, Raw Configuration, And Recovery (`raw-config-recovery.md`) | Settings › Preferences, Voice, Permissions; My Ships |
| Use the Web and Desktop apps → "Web And Desktop" (`apps-desktop/`) | Use The Web And Desktop Surfaces (`desktop-surfaces-and-apps.md`) · Use Voice (`voice-gestures.md`, no gestures) · Read Images With `img2txt` | all views, Desktop shell |
| Find any command or capability → "Find Any Command Or Capability" (`reference/`) | Command Map · Shell, CodeMode, Network, And One-Shot AI · Troubleshooting | – |

Observations on the manual tree alone:

- Link text differs from the target H1 on 16 of the 21 "I Want To…" rows by wording, 20 of 21
  counting case (`manual/index.md:22-44`). Several pages carry two or three labels:
  `conversations-delegation.md` is "Messages and activity", "Work controls" and "Messages, work,
  and delegation"; `ledger.md` is "The ledger" and "Logs"; `credentials-sharing.md` is "Passwords,
  sessions, and people", "Passwords, sessions, tokens, machines, and external identities" and
  "Passwords, sessions, and access". Each label becomes its own translation key.
- Folder and file slugs do not match titles (`devices-workplaces` ↔ "Computers And Browser",
  `agents-assistants` ↔ "Talk With Ship And Manage Work", `ledger.md` ↔ "Logs",
  `voice-gestures.md` ↔ "Use Voice"). Slugs are addresses the agent uses (`wiki read
  gsv-manual/pages/...`), so they should stay untranslated; the mismatch only matters because
  people reading the tree see both.
- H1/H2 are Title Case with every word capitalised ("Talk With Ship And Manage Work"); link text
  is sentence case; three H1s are sentence-case exceptions ("Create your Ship", "Finish setup",
  "Connect with another Ship").

### 1.3 The interface's tree

As the person meets it (`web/src/app/features/instrument/Instrument.tsx:44-50` route table;
`shared/InstrumentHeader.tsx:42-52` nav; settings ids `settings/Settings.tsx:28`).

- **Before a session**: `/connect` "Connect on Ship" · login "WELCOME BACK" / "ADMINISTRATOR SIGN-IN"
  · `/onboarding` "Step 1 of 2 / Step 2 of 2" ("Welcome to {handle}" · "Before you begin") ·
  setup-recovery "Finish setting up Ship" · `/recover-member` "RECOVER ACCOUNT" · `/recover`
  "RECOVER YOUR Ship".
- **Signup** (`/owner/signup/`, `OwnerWelcomeScreen.tsx`): welcome → invitation → claim ("Create
  your Ship", Handle, "Ship address {handle}.{domain}") → email ("Open Ship" / "Sign in with email" /
  "Enter a Ship address") → code ("Check your email") → spaces ("Choose your Ship").
- **Instrument** header: wordmark "Ship" · nav `c chat` · `f fleet` · `m memory` · `p people` ·
  `s settings` · `? help` · "helper · back to your Ship" when a non-Ship process is open.
  - **Chat** (internal id `zen`, route `/chat`): transcript (sender "Ship" / username; notes "memory"
    / "event" / "error") → context bar: "plans" / "{N} ongoing" → **Plans** panel with tabs
    `ongoing | routines | history` → composer "Message your Ship", @-picker "Places" (starts on
    "your cloud @gsv"), "+" menu "Add to chat" (add context: attach a file / find a person /
    reference a file; ask Ship: create a routine / connect a computer / start a browser), place
    chooser "Places and live browsers", "+ connect place" → panel "Connect a computer".
    Overlay "Live cloud browser".
  - **Fleet**: **Places** (table Place / Kind / State / Last seen / Runs today; "connect" → "Connect
    a place": "Give your Ship access to another computer or browser."; place → "run a command" /
    "browse files" / "talk about it"; "pair again" / "forget place") · **Processes** ("new process"
    → "Start a separate conversation with your agent."; table Process / Id / Responsibilities /
    State / Last active / Today; row → "open conversation" / "stop", "Next run", "recently").
  - **Memory**: "Collections" tabs → "Pages" / "Matches" tree → page → "ask Ship", "edit", "new
    page". Empty state: "Your Ship writes what it learns about you into its personal wiki…".
  - **People**: h1 People / Contacts / Requests / Sent requests / Past requests · "connect" →
    "Connect with someone" (create invitation link / I have an invitation / use a profile address)
    · conversation → "details" (Automatically handle new messages; Connection; **Work requests**)
    · "your profile" → "Your profile" (save draft / publish profile).
  - **Settings** (`/chat/settings?section=`): the rail prints the raw ids, the page shows a
    different h1 in three cases:

    | rail (raw id, CSS uppercase) | h1 shown |
    |---|---|
    | preferences | Preferences (Model order · Reasoning effort · Response language · Timezone · Appearance) |
    | voice (Desktop only) | Voice (Microphone · Handsfree mode · Spoken replies) |
    | **standing** | **Standing responsibilities** |
    | permissions | Permissions (Allow / Ask / Block; groups Filesystem · Shell · Network · Mail · Web search · Repositories · Processes · MCP · System Config; scopes All machines · Ship computer · Cloud browsers · Cloud computers · Machines) |
    | instructions | Instructions ("Your standing instructions, in Markdown") |
    | messengers | Messengers ("Choose where you talk to your Ship."; body says "messaging connections") |
    | **mcp** | **MCP servers** |
    | logs | Logs (table "Syscall history", dialog "Activity") |
    | sign-in (root only) | Sign-in (Personal sign-in · Account recovery) |

- **Desktop shell**: welcome (same six signup steps) → "Ship" menu (`{host}` · recover account ·
  this computer · disconnect · quit) → "Connect this computer" dialog → Instrument. Dialogs
  "Disconnect from this Ship?" and "Quit Ship?".
- **Outside the app**: Accounts "My Ships" (sign in → check your email → My Ships → Recover a
  Ship); the "Your Ship" extension (side panel: "Connect this browser to your Ship." → "In your
  Ship, open Fleet and choose Connect."); messenger bots; the `gsv` CLI.

### 1.4 Where the two trees disagree

| Topic | Manual | Interface |
|---|---|---|
| Where ongoing work lives | "Chat … with contextual responsibilities and routines"; Fleet "lists your places and processes" (orientation.md:30) | Responsibilities and Routines render only inside Chat's **Plans** panel (`shared/Responsibilities.tsx`); Fleet shows Places and Processes. Matches, but the manual calls the panel "N ongoing (or plans)" and the page describing it is titled "Messages, Work, And Delegation". |
| Where the ledger lives | Section "Talk With Ship And Manage Work" → page "Logs" (`ledger.md`); index links it as "The ledger" | Settings › logs → "Logs" → "Syscall history" / "Activity" |
| What Settings holds | "preferences, standing responsibilities, permissions, instructions, messengers, MCP connections, and Logs" (orientation.md:30) | rail: preferences · voice · standing · permissions · instructions · messengers · mcp · logs · sign-in. "voice" and "sign-in" are missing from the manual's list; "MCP connections" is "MCP servers" on screen. |
| Settings tab casing | "Settings → messengers" (settings/index.md:17) and "Settings → Messengers → Telegram" (adapters-routing.md:27); "Settings → preferences" and "Settings → Preferences → Response language" (voice-gestures.md:86) | ids are lowercase, rendered uppercase by CSS; h1s are capitalised, rendered lowercase by CSS |
| Connecting a machine | "Connect A Computer" (devices-workplaces/index.md:13); "Fleet → Places → connect" (settings/index.md:24); "Chat → + → connect a computer" | Fleet "connect" → "Connect a place"; Chat "+ connect place" → panel "Connect a computer"; Desktop "Connect this computer"; extension "open Fleet and choose Connect" |
| People / Contacts | Section page is "Connect with another Ship"; index links it as "Contacts and cross-Ship requests"; `accounts-access` links it as "People" | view **People** with sub-views Contacts / Requests; dialog "Connect with someone" |
| Manual's own name | wiki title "Ship Manual" (`manual/wiki.json`), id `gsv-manual` | skill says "Ship Manual"; AGENTS.md and man page say "GSV Manual" |
| Voice | page "Use Voice" under "Web And Desktop"; `05-voice.md` is Ship's writing persona | Settings › voice (speech, Desktop only) |
| The `gsv` target | "Ship itself", "the installation itself", **your cloud**, "GSV", `gsv` | "your cloud" (`fleetModel.ts:11`), "Your cloud home" (`Preferences.tsx:141`), "the cloud home" (`ledgerLabels.ts:101`), "Ship computer" (`agentToolApprovalOptions.ts:157`), `@gsv`, "The gateway's own filesystem…" (`fleetModel.ts:101`) |

## 2. Naming matrix

One row per concept, one column per surface, the label used on that surface. A cell with several
entries is a terminology inconsistency on that surface; a row whose cells differ is one across
surfaces. Citations for every cell are in `term-inventory.md` (section 4 of each surface).

Surfaces: **M** manual · **UI** Instrument web, signup, desktop shell · **D** docs · **X** extension
· **A** adapters (messenger replies) · **Acc** Accounts pages · **H** CLI/desktop/daemon ·
**P** prompts/skills/man pages.

| Concept | M | UI | D | X / A / Acc | H | P |
|---|---|---|---|---|---|---|
| The product | Ship; "GSV runtime" | Ship | Ship; GSV (architecture pages); "personal AI computer", "Linux-shaped cloud computer", "personal cloud computer" | Ship (X, Acc); **GSV** (A) | Ship; GSV Desktop; GSV (daemon) | Ship; GSV (runtime rule, but used for the instance, the agent, the target and the brand) |
| The agent (personal intelligence) | Ship; personal intelligence; personal agent; personal-intelligence account; `ship` account; "your personal Ship" | Ship; "your Ship"; lowercase "ship" (Fleet row); "personal intelligence" once; "your agent(s)" | Ship; personal agent; personal intelligence; personal process; "your agent(s)" | Ship (X); "I" / "your GSV" / "[PERSONAL INTELLIGENCE]" (A) | "the agent"; "personal agent"; "personal intelligence"; "Talk to Ship" | Ship; "personal intelligence"; "personal agent"; GSV (setup-assist) |
| The hosted instance | Ship; installation (28×, undefined); `YOUR-SPACE`; deployment; Gateway; Kernel; "My Ships" | Ship ("Create your Ship", "Ship address", "Choose your Ship", "Disconnect from this Ship?"); installation ("Included with your installation"); `space` in code | Ship; space; installation; GSV instance; Ship gateway; deployment; `{#…-space}` anchors | Ship, "My Ships" (Acc); installation ("Installation ID", "NEW INSTALLATION"); `{origin}` URL (A); "your GSV" (A) | Ship; gateway; space; kernel; "Ship OS" / "gateway OS" | Ship; "the user's Ship"; "this GSV" (man mail) |
| Handle / address | handle = address; `esteve.ship.space`; also `gsv.space` | handle; "Ship address {handle}.{domain}"; "@handle, name or address" | handle; Ship address; GSV address; profile address; public address | "yours.ship.space" (X); handle (Acc) | "Gateway URL"; "HTTPS address of your Ship" | handle; `<handle>.{{ship.domain}}` |
| Owner account | owner account; personal human account | "personal account"; "Your session"; username | personal account (human) vs personal account `ship` (agent) | owner; "verified owner" (Acc) | local user; Gateway username; owning human | Owner |
| Root | root; **admin** link; administrator access | "admin" toggle → "ADMINISTRATOR SIGN-IN"; "root password" (recovery) | root; admin | administrator (Acc; "root" never shown) | root | – |
| Crew / other agents | Crew account; `crew`; work identities; specialized identities; specialized agents; worker; "your agents" | helper; process; "your agent"; "New work"; "work process {pid}"; PERSONAL AGENT (unrendered) | Crew (undefined on user pages); custom agent accounts; "your devices are the crew" (FAQ) | – | process; `kind=personal\|work` | Crew; specialist; delegated child |
| Work item / process | Work; work item; Work Session; work session; Processes; process; task; piece of work; worker; work shell | Processes; "new process"; helper; "work process"; "New work"; "view process" | Work; work session; WORK SESSION; work process; process (undefined on user pages) | `[WORK SESSION]` (A) | process; conversation (Desktop CLI) | process; task; "Ship work" |
| Conversation | Ship ("the main conversation"); Chat; conversation | chat (nav); Chat (aria); "Search conversation"; `zen` (id, `/zen` redirect); "open conversation" | Chat; conversation; **Zen** (6×, undefined) | – | conversation; chat | "your Ship conversation" |
| Messages vs activity | Messages / Activity | "activity" (message fold); "Activity" (ledger dialog); "Chat activity"; receipts | Process activity; Message | – | – | – |
| Send / yield | Send; `yield` | "A response needs to finish with Send" (only mention) | Send; yield | – | – | Send; yield |
| Ledger / logs | ledger; **Logs** (page title); "The ledger" (link); Action history; Action records; raw | Logs; "Syscall history"; "Activity"; "read the ledger"; "recently" | The ledger; Logs; "action records" | – | – | ledger |
| Responsibility ledger | responsibility ledger (`r12y`); "Ship's ledger holds one system responsibility" | – | responsibility ledger; "Open ledger records" | – | – | r12y; responsibility ledger; commitments |
| Ongoing work | responsibilities; `r12y`; **N ongoing**; **plans**; ongoing plans; standing responsibilities; event-driven responsibilities; event-driven policies; contextual responsibilities; promises and follow-ups; commitments; assignments | Responsibilities / Past responsibilities; "plans" / "{N} ongoing"; Plans panel; "steps"; "Standing responsibilities" (a different thing: event-driven sources) | responsibility; ongoing plans; N ongoing; Standing policies; Open ledger records | – | – | responsibility; r12y ("prioritize this r12y"); commitments; "Delegated task" |
| Routine / schedule | routines; new routine; schedule; `sched`; automation; "reminder or recurring job"; `crontab` | Routines; "new routine"; "scheduled task"; "Custom schedule"; "created a schedule" / "ran scheduled work" | routines; recurring schedules; `every` or `cron` schedules | – | – | reminder; recurring task; schedule; cron (forbidden word); "routines" = personal habits in the memory skill |
| Target | target; place; "where work can run" | "Target" / "Target ID" field labels only | target (technical: Unix-shaped capability environment) | – | target; target id; "target uid" (other sense) | target; named targets |
| Connected machine | computer (109×); machine (credentials, daemon); device (32×, undefined); laptop; server; connected user device | place; "Connect a place"; "Connect a computer"; "Connect this computer"; machine ("All machines", "Choose a machine"); device ("device connection"); node ("node tokens"); Target ID | device (sidebar "Connect Devices"); machine (H2 "Connect a machine"); computer (UI quote); place; target | "this browser" (X); "a connected place" (A) | device; machine; computer; node (legacy); laptop (tests); "Machine ID" vs "Device ID" for one `--id` | computers and browsers; connected user devices; machines; places |
| The `gsv` target | Ship itself; the installation itself; **your cloud**; GSV; `gsv`; Ship | your cloud; Your cloud home; the cloud home; Ship computer; the Ship Worker; "The gateway's own filesystem…"; `@gsv`; `@cloud` / `@home` aliases | your cloud; cloud home; default cloud place; native cloud target; Native Gateway target; the GSV target; native `gsv` target | "in your cloud home" (A); "gsv" fact label → "GSV" (X) | gateway; "Ship OS" | "the user's cloud"; "cloud filesystem"; "native cloud target"; "cloud home"; GSV; "Native GSV capability environment" |
| Cloud computer | cloud computer; on-demand Linux computer; computer target | Cloud computers (permission scope); "start a cloud instance" (ledger) | cloud computer (feature) vs "personal cloud computer" (the product) | – | "private cloud instance" (daemon `--container`) | on-demand cloud instances |
| Browser target / extension | browser target; **Your Ship** extension; "Ship's live view" / "browser view" / "live view" / "the viewer" | Cloud browsers; "Live cloud browser"; "Your Ship icon"; "start a browser" | **Your Ship** extension; browser profile as pseudo-computer | "Your Ship" (manifest) vs "Your GSV" (titles); "GSV Viewer" vs "Ship Viewer" | – | "Your GSV from the toolbar" (stale); browser capability |
| Desktop app | Desktop; "the Desktop app"; Ship menu | Ship ("Quit Ship?"); "Ship Desktop"; "the beta desktop app"; "the app" | Ship Desktop; Desktop; Desktop app; native Desktop; GSV Desktop (H2) | – | Ship (productName); GSV Desktop; Ship Desktop; GSV.app; "Desktop application"; CFBundleName "GSV" | "GSV Web Desktop" (origin label for both web and Desktop) |
| CLI | `gsv`; "host CLI" | "install Ship" then `gsv pair` | `gsv` CLI; operator CLI; external CLI; native CLI | – | "Ship CLI" | – |
| Messaging | messenger (33×); adapter (9×, undefined); messaging apps; linked apps; surface; bot; "Settings → messengers/Messengers" | Messengers (h1); "messaging connections" (body); "messenger links"; "messaging identity"; "messaging link"; "Adapter returned…" (error) | messenger (user pages, sidebar); **adapter** ("User-facing docs prefer adapter", adapter-model.md:65); channel (redirects, deployment names); integration; Messengers console | "Messengers" (A path); "GSV Telegram", "GSV app", "the bot" (A) | adapter only (`gsv adapter`; "messenger" 0×) | messengers; adapter (man); connection (welcome.md umbrella) |
| Integration / MCP | MCP; OAuth; "integration" undefined; "connected services" | MCP servers; "Connect tools and resources to your Ship." | Integrations (MCP) ; "integration" also = adapter | – | – | "Integrations connect from Settings, mcp"; MCP integrations; MCP servers |
| Email | Ship's email address; `<handle>@ship.space` and `<handle>@gsv.space` | never shown; "Mail" permission group | mailbox (syscalls); "Email is an optional operator-composed service" | "mailbox" (SMTP rejects) | – | "The Ship's email address" vs "this GSV's own mailbox" |
| Contacts / people | People (view); Contact (capitalised) / contact; "Connect with another Ship"; "Pair With Someone" | People / Contacts / Requests; "Connect with someone"; "connection"; "end connection" | People; Contact ("a conversation with an authenticated person on another space") | "Connect on Ship" (Acc signup) | – | contact; "connect with people on other Ships" |
| Memory / knowledge | Memory (view); personal knowledge pages; personal memory; the personal wiki; the `personal` wiki; knowledge collection; saved knowledge; wiki | Memory; "personal wiki"; Collections; "library" (errors); "applied repository changes" (ledger); "memory" (compaction note) vs "from your memory:" (wiki links) | Memory; personal knowledge pages; Personal wiki; `personal` collection; "Context and Memory" (sidebar) vs "Context and Knowledge" (page) | – | – | Knowledge (H1 of `15-memory.md`); memory (skill); `personal` wiki; Personal wiki; knowledge databases; collection; notes; DURABLE KNOWLEDGE |
| Instructions / standing context | Settings → instructions = `~/context.d/`; standing context; personal context; shared personal context; Account context; system context | Instructions; "standing instructions"; "standing context"; "instructions folder" | System / Program / User context vs System / Home context; standing context; instructions | – | – | standing context; standing memory; Personal Context; user context; STANDING CONTEXT (agent's own) |
| Approval policy | Allow / Ask / Block (UI) vs `auto / ask / deny` (policy) vs "allow, deny, or ask" | Allow / Ask / Block (policy); "run it / don't / always allow" (card) | Allow / Ask / Block; always allow / Always allow | Approve once / Always approve / Deny → "Approved for this conversation." (A) | "Approve [o]nce, [a]lways, or [d]eny?" | – |
| Settings | Settings; configuration (key/value); "Settings → …" paths | settings (nav) → Preferences (default section); "config" never shown | Settings; configuration; console | "Settings → sign-in" (Acc) | config (`gsv config`); "remote kernel config" | "Settings, messengers" / "Settings, mcp" (welcome.md) |
| Web app | Instrument; "the Web app"; Web | never named ("Ship" wordmark); "the console" (legacy) | Instrument; web console; web UI; web application; Instrument UI; "the app" | – | – | – |
| Fleet | Fleet; "the operational view" | fleet (nav); Fleet (aria) | Fleet; "Machines console" | "open Fleet and choose Connect" (X) | – | Fleet (once) |
| Invitation | people invitation (7 days UI / 1 hour CLI default); device invitation (10 min); extension pairing invitation; signup invite code | contact invite; device-pairing invite; operator setup link; profile policy "By invitation" | contact invitation; device invitation; operator setup invitation | "invitation" (X); "pairing code" (A) | invitation; pairing code; link code; setup link | – |
| Session | sign-in session; app session; Work Session; website sessions; shell `sessionId`; dictation session; Desktop run; "Sessions" (H1) | "Your session"; session expired | work session; sign-in session; shell session; "Process, Not Session" | – | auth session; Desktop session file; shortcut session | – |
| Operator | operator (27×, undefined); "installation operator policy" | "your operator"; "operator's owner sign-in page" | hosting operator; operator administration | Operator (Acc); "private operator surface" | "from your operator" | "operator of this installation" |

## 3. Definitions register

For each key concept: what the manual says, what the docs say, what the interface implies, and
whether they agree. "undefined" means the word is used but never explained on that surface.

| Concept | Manual | Docs | Interface | Agree? |
|---|---|---|---|---|
| Ship (product) | "Ship is your personal spaceship. It stays in orbit while you live your life down here on Earth." (orientation.md:5); "Ship is the product name. GSV remains the runtime name" (:84) | "a personal AI computer, or … a distributed OS with AI in the kernel" (why/index.md:7, faq.md:7); "Linux-shaped cloud computer" (index.md:21); "GSV is a personal cloud computer" (architecture/index.md:3) | "Ship is an AI assistant that can use your computer and connected services to get things done." (SetupScreen.tsx:68); PWA "Ship desktop and agent operating shell." | No. Four different framings; "cloud computer" collides with the Cloud Computers feature. |
| Ship (agent) | "Ship names your continuing relationship with the personal intelligence." (orientation.md:28); "Ship is the main conversation with your personal intelligence." (agents-assistants/index.md:9) | conversation (get-started/index.md:13; conversations.md:67) vs process (responsibilities-and-context-epochs.md:9) vs account (process-ipc-and-scheduler.md:96) | "Message your Ship"; "{identity} now reaches your personal intelligence" (ManagedTelegramOnboardingFlow.tsx:334) | Partly. Relationship / conversation / process / account are four answers to "what is Ship". |
| Hosted instance | undefined; "installation" 28×, "space" only as `YOUR-SPACE` | "Each installation keeps its own Kernel, accounts, credentials, processes and data." (operate-gsv.md:5); "A space has one personal human account…" (security-model.md:29) | undefined; "Create your Ship", "Ship address", "Included with your installation" | No shared noun. Users meet "Ship", "installation" and "space" for one thing. |
| Handle / address | "the handle is its address … `esteve.ship.space` … `esteve@ship.space`" (orientation.md:15-18); also `<handle>@gsv.space` (integrations/index.md:23) | handle `@alex` and address `alex.example.com` (get-started/index.md:29); public address `https://YOUR-SPACE/profile` (contact-people.md:55); mail address (cli-commands.md:247) | "Ship address {handle}.{domain}" (OwnerWelcomeScreen.tsx:230) | Mostly, except the manual contradicts itself on the domain and "address" has three referents in the docs. |
| Target | "a place where an action can run" (index.md:69); "`gsv` means the installation itself" (targets-copy.md:5) | "an addressable, Unix-shaped capability environment" (targets.md:3); includes external service accounts | "Target" / "Target ID" field labels; "$ command — Run a shell command on that target" | Different scope: the manual's targets are computers and browsers; the docs' include services. |
| Place | "The Web app calls connected targets **Places**." (index.md:69) | undefined; "The place the call went to: a target id, or `gsv` for the cloud home" (ledger.md:24) | "Give your Ship access to another computer or browser." (ConnectPlace.tsx:14); the place picker also lists "your cloud" | Partly. The manual says Places are connected targets; the UI lists the cloud among places too; mkdir ledger text uses "place" for a folder (fleetModel.ts:262). |
| Machine / computer / device | "A **machine identity** authenticates one connected computer." (accounts-access/index.md:12); "device" undefined | "**Machine** — A physical or virtual computer that may provide one hardware-backed target." (targets.md:25); "Connecting a device turns it into part of one computer" (connect-devices.md:3) | "Let your Ship use this computer's files and commands, even when the app is closed." (DesktopMachineSetup.tsx:112) | The things agree; the nouns do not. |
| Cloud computer | "an on-demand Linux computer to work with documents…" (cloud-computers.md:5) | "an on-demand Linux environment for documents, spreadsheets…" (cloud-computers.md:3) | label only ("Cloud computers") | Yes. |
| Cloud browser | "an on-demand cloud browser that Ship starts and manages" (browser-targets.md:7) | "lets Ship use websites while your personal devices are offline" (cloud-browsers.md:3) | implied by "Live cloud browser" overlay | Yes. |
| Browser target / extension | "A browser target can be the user's browser connected through the **Your Ship** extension, or an on-demand cloud browser" (browser-targets.md:5-7) | "through a cloud browser or your personal browser connected with the **Your Ship** extension" (browse-web.md:3) | "Click the Your Ship icon in the toolbar" (DevicePairingPanel.tsx:74) | Yes, but the extension's own page titles say "Your GSV" and the browser-target skill tells the agent to say "open Your GSV from the toolbar" (skills/browser-target/SKILL.md:365). |
| Messenger / adapter | Connect vs Link: "**Connect** gives Ship access to the messaging service or bot account. **Link** binds an external sender to the Ship owner" (adapters-routing.md:7-8); "adapter" undefined | "**Adapter** — The owner of an external messaging protocol…" (targets.md:26); "User-facing docs prefer **adapter**" (adapter-model.md:65) | "Choose where you talk to your Ship." (MessengerConnections.tsx:45) | Contradiction in the docs; the UI, the manual and the sidebar say messenger; the CLI says only adapter. The manual's `messenger connect` command performs the "Link" step (adapters-routing.md:18-19). |
| Integration | undefined; section covers messaging, email, MCP, OAuth | "Integrations give Ship new tools through MCP servers" (integrations.md:3) | "Connect tools and resources to your Ship." (Mcp.tsx:46) | No. Docs scope it to MCP; the manual's "Integrations" section is wider; welcome.md uses "integration" for MCP and "connection" as the umbrella. |
| Contact | "A Contact connects your Ship to a person on another Ship." (integrations/index.md:11); "joins" (contacts.md:5) | "**Contact** is a conversation with an authenticated person on another space." (conversations.md:83) | "Connect with someone on Ship. Talk directly, share things…" (PeopleWelcome.tsx:20) | Partly: relationship vs conversation. |
| Ledger / Logs | "the record of every action Ship took: who asked, where it ran, what it did, why, and how it ended" (index.md:71); page titled "Logs" | "the Kernel's record of what ran: one line per syscall" (ledger.md:3) | "Syscall history" (Logs.tsx:52); "Commands run directly and appear in Logs." (Fleet.tsx:524) | Same thing, three names; "ledger" also names the responsibility store on both doc surfaces. |
| Responsibility | "Promises, follow-ups, delegated work, and recovery that must survive a run are recorded as responsibilities." (conversations-delegation.md:91) | "unresolved work that must survive the current run" (responsibilities-and-context-epochs.md:22) | "Nothing outstanding. Promises and follow-ups appear here." (Responsibilities.tsx:81) | Yes in substance; the UI label is "plans" / "ongoing". |
| Standing responsibilities | "Event-driven responsibilities Ship takes care of" (settings/index.md:15) | "Event-driven policies live in **Settings → standing**" (get-started/index.md:96) | "What Ship takes care of when something happens." (StandingResponsibilities.tsx:21) | Yes, but "standing" also means standing context / standing instructions on every surface. |
| Routine | undefined (14 uses) | undefined on user pages; "Recurring custom responsibilities are ordinary `every` or `cron` schedules" (process-ipc-and-scheduler.md:303) | "Give Ship something to take care of regularly." (Responsibilities.tsx:100); "This scheduled task can be inspected and paused here." (:160) | The UI is the only place that explains it; the prompts say "reminder or recurring task". |
| Delegation | "Delegation is immediate, bounded work." (schedules-processes-delegation.md:58) | "durable delegated work" (process-ipc-and-scheduler.md:124) | "Delegated work approvals" (DelegatedApprovals.tsx:45) | "immediate, bounded" vs "durable" is a real disagreement. |
| Crew | "a Crew account for delegated work" (accounts-access/index.md:15) | "an ordinary owned `crew` account for delegated work" (context-files.md:52); "your devices are the crew" (faq.md:114) | absent | The UI never shows Crew; a user who reads "Ship and Crew" in the docs cannot find it. |
| Memory / wiki | "A wiki is a repository organized for searchable knowledge." (repositories.md:7); "Personal memory contains concise, supported facts in the person's terms." (context-files-knowledge.md:32) | "Personal wiki — Human-owned durable, searchable personal memory shared by all owned agents." (context-and-knowledge.md:32) | "Your Ship writes what it learns about you into its personal wiki as you work together, and this is where you read it and put it right." (Memory.tsx:236) | Yes in substance; the names diverge (Memory / wiki / collections / knowledge). |
| Instructions / context files | "Files in `context.d` are loaded automatically. Use them for concise identity, preferences, constraints, and voice" (context-files-knowledge.md:36) | layers System / Program / User (context-files.md:9-11) vs System / Home / skills (agent-loop.md:99-102) | "Your standing instructions, in Markdown. Agents inherit their owner's instructions alongside their own." (Instructions.tsx:95) | The docs disagree with themselves on the layer names. |
| Approval | "An approval is bound to one exact request." (identity-context-approvals.md:49); policy "Allow / Ask / Block" vs `auto / ask / deny` | "`action` is `auto`, `ask`, or `deny`. The console labels them **Allow**, **Ask**, and **Block**." (configuration.md:167) | "Choose when your agents ask before using a capability." (Permissions.tsx:42); card "run it / don't / always allow" | Yes; the messenger buttons add a fourth vocabulary (Approve once / Always approve / Deny). |
| Operator | undefined (27 uses); "Operators configure the default domain" (orientation.md:90) | "The hosting operator provisions and operates the Cloudflare resources for you." (deploy.md:5) | "Your agreement with {operatorName ?? 'your operator'}" (PolicyLinks.tsx:8); "your operator's owner sign-in page" | Defined only in the docs. |
| Instrument | "The Web app is called **Instrument**. It has five views" (orientation.md:30) | "The web console is called **Instrument**" (get-started/index.md:76) | never named | A name that exists only in documentation. |
| Fleet | "Fleet is the operational view" (desktop-surfaces-and-apps.md:51) | "lists your places and processes" (get-started/index.md:79); "Machines console" (adapter-model.md:43) | nav label only | Only documentation explains it; the extension sends people to "Fleet → Connect". |

## 4. Inconsistency findings

Classified by kind. Evidence for each is in `term-inventory.md`; the most consequential cases are
cited inline.

### 4.1 Same thing, different names

| # | Thing | Names in use | Where it bites |
|---|---|---|---|
| S1 | The hosted instance | Ship · space · installation · deployment · gateway · registry · kernel · OS | Admin page puts "NEW INSTALLATION" above "Create a Ship" and "Installation ID" under "SHIP" (`workers/installations/src/admin/installations-page.ts:72,104,113`); Desktop shows "The selected Ship has changed." and "The configured space has changed." for one condition (`host/apps/desktop/src/main.rs:123,262`); Accounts UI says "My Ships" while route, code and AGENTS.md say spaces. |
| S2 | The connected machine | place · computer · machine · device · node · target · laptop | "+ connect place" opens "Connect a computer" (`web/src/app/features/instrument/zen/Zen.tsx:1266` → `ChatPanels.tsx:40`); Permissions call browsers "machines" (`agentToolApprovalOptions.ts:153,171,240`); `gsv daemon install --id` is "Machine ID" while `gsvd --id` is "Device ID" (`host/apps/cli/src/cli.rs:200`, `host/apps/machine/src/app.rs:32`); the docs sidebar says "Connect Devices", its H2 "Connect a machine", its UI quote "connect a computer". |
| S3 | The `gsv` target | your cloud · Your cloud home · the cloud home · Ship computer · Ship itself · the installation itself · GSV · `@gsv` · `@cloud` / `@home` · "The gateway's own filesystem" · cloud filesystem · native cloud target | Users see "your cloud @gsv" in the picker (`Zen.tsx:1143`), "Ship computer" in permissions, "Delete x from gsv?" (`FileReader.tsx:130`), "{user}@gsv $" on approval cards. welcome.md:93 instructs the agent that "The interface never calls it a filesystem", but the Fleet inspector shows "The gateway's own filesystem…" (`fleetModel.ts:101`). |
| S4 | Ongoing work | responsibilities · plans · ongoing · steps · routines · schedules · scheduled task · standing responsibilities · event-driven policies · commitments · promises and follow-ups · r12y | Chat button "plans" / "{N} ongoing" opens a panel titled "Plans" whose sections are headed "Responsibilities" and "Routines" (`ChatPlans.tsx:11`, `ChatPanels.tsx:40`, `Responsibilities.tsx:77,89`); Settings "standing" is a different thing (sources). The prompts tell the agent to say "reminder or recurring task" (welcome.md:14,95) and the memory skill uses "routines" for personal habits (`skills/memory/SKILL.md:73`). |
| S5 | Knowledge | Memory · personal wiki · Collections · library · repository · knowledge · personal knowledge pages · notes | Memory errors say "library" (`services/memory/libraryModel.ts:17`); the ledger shows memory edits as "applied repository changes" (`ledgerLabels.ts:94`); "memory" also labels compaction notes in Chat (`ZenNotes.tsx:40`); the prompt H1 is "Knowledge" in a file named `15-memory.md`. |
| S6 | Instructions | Instructions · standing instructions · standing context · context files · `~/context.d` · personal context · user context · Program context · Home context | Settings h1 "Instructions" (`Instructions.tsx:90`) glossed as "standing instructions" and "standing context" (:95); docs give two incompatible layer lists (`docs/reference/context-files.md:9-11` vs `docs/architecture/agent-loop.md:99-102`). |
| S7 | Messaging | Messengers · messaging connections · messenger links · messaging identity · adapter · channel · integration · surface · bot | h1 "Messengers" over body "messaging connections" (`MessengerConnections.tsx:44,46`); CLI has only `adapter` (0 occurrences of "messenger" in `host/apps`); `docs/architecture/adapter-model.md:65` says user docs prefer "adapter" while every user page says "messenger". |
| S8 | Agents that are not Ship | helper · process · agent · Crew · worker · work identity · specialized agent · delegated child | Header "helper · back to your Ship" (`InstrumentHeader.tsx:35`); Fleet "new process" → "a separate conversation with your agent" (`ProcessControls.tsx:75`); Permissions "your agents" (`Permissions.tsx:42`); ledger "started a helper" (`ledgerLabels.ts:61`). "Crew" appears in the manual, the docs and the prompts but never in the UI. |
| S9 | The ledger | Logs · ledger · The ledger · Activity · Syscall history · Action history · Action records · recently | Manual page H1 "Logs" at `ledger.md`, linked as "The ledger"; docs sidebar "The Ledger"; UI "Logs" → "Syscall history" → dialog "Activity". |
| S10 | Desktop app | Ship · Ship Desktop · GSV Desktop · GSV.app · "the beta desktop app" · "Desktop application" · "GSV Web Desktop" | `gsv desktop` help says "GSV Desktop" (`cli.rs:98`); the origin label the model sees is "GSV Web Desktop" for both the browser app and Desktop, because both send clientId `gsv-ui` (`workers/gateway/src/prompts/context-origin.ts:90-91`). |
| S11 | Web app | Instrument · web console · web UI · web application · Instrument UI · the app · the console | Named "Instrument" only in the manual and docs; the app never names itself. |
| S12 | Public domain | `ship.space` · `gsv.space` | The manual states the user's email as `<handle>@ship.space` (email.md:5) and `<handle>@gsv.space` (integrations/index.md:23), and links `https://gsv.space/browser` for the extension (browser-targets.md:29). |
| S13 | Manual | Ship Manual · GSV Manual · `gsv-manual` · "the manual" · "the live GSV capability manual" (man pages) | `wiki.json` and the skill say "Ship Manual"; AGENTS.md:270 and `man-pages.ts:782` say "GSV Manual"; welcome.md:43 has the agent say "read gsv-manual". |
| S14 | Approval verbs | Allow / Ask / Block · auto / ask / deny · run it / don't / always allow · Approve once / Always approve / Deny · allow, deny, or ask | Four vocabularies for one policy across Permissions, the approval card, messenger buttons and the manual. |
| S15 | Root | root · admin · administrator · ADMINISTRATOR SIGN-IN · administrative login | Login toggle "admin" leads to "ADMINISTRATOR SIGN-IN" and signs in as `root` (`LoginScreen.tsx:51,94`, `useSessionScreensState.ts:153`); Accounts pages say only "administrator". |
| S16 | gsvd | Ship background service · Ship machine daemon · GSV machine driver daemon · the local gsvd service · device daemon · boot service · Ship service | Six names for one process across CLI help, Windows SCM and installers. |

### 4.2 Same name, different things

| # | Word | Senses | Evidence |
|---|---|---|---|
| D1 | **Ship** | product; agent; conversation; hosted instance; desktop app; CLI ("install Ship"); extension ("Your Ship"); messenger bot ("@Ship", "official Ship bot"); model ("Ship included"); account name `ship`; contact-handling value `ship`; `/ship` messenger command | Signup: "Create your Ship" (instance) then "Message your Ship" (agent); DevicePairingPanel: "install Ship" then run `gsv pair`; `aiProviders.ts:15` "Ship included". Rename leftovers: "RECOVER YOUR Ship" (`AccountRecoveryScreen.tsx:32`), "INSTALL Ship IN {PLATFORM}", "MESSAGE Ship" (`ManagedTelegramOnboardingFlow.tsx:196-284`). |
| D2 | **ledger** | the syscall log (Logs); the responsibility store (`r12y`); the migration ledger (docs) | manual `index.md:71` vs `context-files-knowledge.md:11,42,84`; docs `ledger.md:3` vs `responsibilities-and-context-epochs.md:41`. |
| D3 | **standing** | Settings › standing (event-driven responsibilities); standing context / standing instructions (`context.d`) | manual `settings/index.md:15` vs `:16`; UI `StandingResponsibilities.tsx:21` vs `Instructions.tsx:95`. |
| D4 | **place** | connected target; the cloud target; a surface where you reach Ship; a message destination; a ledger column; a folder ("made a place for files", `fleetModel.ts:262`); the pairing form's platform picker ("Place: Mac/Linux/Windows/Browser", `DevicePairingPanel.tsx:47-58`) | |
| D5 | **request** | People message request; cross-Ship structured request; "Work requests" (contacts); composer request to Ship; approval request; browser sign-in request; instance request id | `People.tsx:136-153`, `Contacts.tsx:125`, `FleetApproval.tsx:55`; manual `contacts.md:35,186,209`. |
| D6 | **invitation** | contact invitation (7 days in UI, 1 hour by CLI default, `contacts.md:21,26`); device invitation (10 minutes); extension pairing invitation; operator setup link; signup invite code (not required); profile policy "By invitation" | |
| D7 | **connect / connection** | pair a machine or browser; create a contact invitation; link a messenger identity; a contact relationship ("end connection"); Desktop "disconnect" = sign out; messenger Connect vs Link (defined as distinct, but `messenger connect` performs Link, `adapters-routing.md:7-8,18-19`) | |
| D8 | **session** | sign-in session; Work Session; website signed-in session; shell session; dictation session; Desktop run; app session; the "Sessions" settings H1; docs "Process, Not Session" | |
| D9 | **workspace** | Slack workspace; Windows daemon folder `%USERPROFILE%\GSV`; cloud computer `/workspace`; process workspace (docs); "Web responsibilities workspace" (docs) | |
| D10 | **identity** | messenger user; OIDC sign-in identity; the Ship's handle ("Ship identity", admin); work identity (agent account); machine identity | `installations-page.ts:77,111,204`; `owner-http.ts:25,62`; manual `accounts-access/index.md:11-13`. |
| D11 | **cloud computer** | the on-demand Linux container feature; the product ("personal cloud computer", "Linux-shaped cloud computer") | `docs/how-to/cloud-computers.md:3` vs `docs/architecture/index.md:3`, `docs/index.md:21`. |
| D12 | **voice** | speech input/output (Settings › voice, manual "Use Voice"); Ship's writing persona (`ship/context.d/05-voice.md`, manual `context-files-knowledge.md:40`) | |
| D13 | **profile** | public People profile; cloud-browser login profile; extension browser profile; AI profile; process profile | |
| D14 | **Activity** | a message's thinking and tool record; the Logs line-inspector dialog | `Feedback.tsx:128`, `Instrument.tsx:330` vs `Logs.tsx:68`. |
| D15 | **memory** | the Memory view / wiki; a compaction-summary note in Chat | `Zen.tsx:300` vs `ZenNotes.tsx:40`. |
| D16 | **Today** | run count (Places) vs USD cost (Processes) | `Fleet.tsx:316,364`. |
| D17 | **manual** | the Ship Manual; the man pages ("the live GSV capability manual", `syscalls/shell.ts:7`); contact handling mode `--handling manual` | |
| D18 | **target** | a target environment; "target uid" (CLI, another user) | `cli.rs:349`. |
| D19 | **service** | gsvd OS service; token kind; operator Workers; service principal; "connected services" (adapters) | |
| D20 | **Desktop** | the app; the OS desktop (shortcut editor) | `shortcuts.rs:62,312`. |
| D21 | **Work** | the process concept; "Work requests" between contacts | manual `index.md:67` vs `contacts.md:209`. |

### 4.3 Defined differently on different surfaces

- **Ship, the product**: spaceship metaphor (manual) vs personal AI computer / distributed OS
  (docs) vs AI assistant (setup screen). Section 3.
- **Target**: computers and browsers (manual) vs any Unix-shaped environment including services
  (docs).
- **Delegation**: "immediate, bounded" (manual) vs "durable" (docs).
- **Contact**: a connection between people (manual) vs a conversation (docs).
- **Integration**: everything connected (manual section) vs MCP only (docs, welcome.md).
- **Context layers**: System / Program / User vs System / Home / skills (docs vs docs).
- **"Always approve"**: the messenger button implies forever; the result says "Approved for this
  conversation." (`telegram-approval.ts:75,161`).

### 4.4 Undefined but load-bearing

Words users meet often that no surface explains: **installation**, **space**, **operator**,
**place** (UI), **process** (UI, manual), **routine** (manual, docs), **Fleet** (UI), **Crew** (UI
never shows it), **Instrument** (UI never shows it), **Zen** (docs, 6 uses), **adapter** (manual),
**device** (manual, 32 uses), **integration** (manual), **collection** (UI), **handle** (UI),
**helper** (UI), **plans** (UI, manual, docs), **surface** (docs, 112 uses).

### 4.5 Label vs title mismatches

- Settings rail prints raw ids: "standing" opens "Standing responsibilities", "mcp" opens "MCP
  servers" (`Settings.tsx:28,59`; h1s at `StandingResponsibilities.tsx:21`, `Mcp.tsx:45`).
- Manual: link text ≠ H1 on most links (section 1.2).
- Docs sidebar ≠ H1 in 14 substantive cases (for example "Operate a Ship Deployment" → "Run Ship for
  your people", "Personal Access" → "One person per Ship", "Target Tools" → `hardware-tools.md`,
  "Storage" → `r2-storage.md`; `docs/.vitepress/config.ts:93-209`).
- Extension: manifest "Your Ship" vs page titles "Your GSV" (`extension/public/manifest.json:3` vs
  `extension/panel.html:6`, `options.html:6`); "GSV Viewer" title vs "Ship Viewer" eyebrow
  (`viewer.html:6` vs `src/viewer/viewer.ts:149`).
- Accounts: "Recovery email" vs "Account recovery" for one page (`owner-email-http.ts:68` vs
  `owner-http.ts:25`); "Recover your Ship" / "Recover a Ship" / "Recover access" for one flow.
- Extension tells the person "open Fleet and choose Connect"; the web heading is "Connect a place"
  (`extension/src/panel/panel.ts:342` vs `ConnectPlace.tsx:13`).
- The browser-target skill tells the agent to say "open Your GSV from the toolbar"
  (`skills/browser-target/SKILL.md:365`); the toolbar item is "Your Ship".

### 4.6 Casing and style drift

- Manual: Title Case headings, sentence-case links, three sentence-case H1s; UI paths drift
  (messengers / Messengers, preferences / Preferences, Send / send, ask Ship / Ask Ship).
- UI: lowercase-label convention ("new routine", "ask Ship", "connect") with CSS uppercase on
  header, buttons and Fleet headings and CSS lowercase on Settings h1s; hand-typed ALL CAPS on
  login/recovery and in the messenger flow; half-converted leftovers "RECOVER YOUR Ship", "INSTALL
  Ship IN {PLATFORM}"; "PERSON" next to "Ship" in sender badges.
- Docs: Title Case sidebar vs sentence-case H1s, and H1 case mixed page to page; UI labels quoted
  with trailing punctuation inside the bold ("**Browser.**", "**add MCP server.**"); mixed British
  and US spelling (organisation / authorise vs authorization / catalog).
- Manual: curly vs straight apostrophes, "labelled" vs "labeled".
- Adapters: "paste the code below" (Telegram, WhatsApp) vs "enter the code" (Discord, Slack);
  approval result strings copied in three files; owner code errors in two divergent copies.

### 4.7 Claims that contradict each other (not names)

Noted in passing because translators will copy them:

- Contact invitation lifetime: seven days (manual `contacts.md:21`, UI) vs one hour by default from
  `contact invite create` (`contacts.md:26`).
- Docs: "runs in your own Cloudflare account … never routed through us" (`why/index.md:21`) vs
  "Your Ship's state lives in its operator's Cloudflare account." (`faq.md:56`).
- Docs: Workers Free baseline (`why/index.md:30`) vs "Do I need a paid Cloudflare plan? Yes"
  (`faq.md:29-31`).
- Docs: "talk to Ship from Telegram, Discord, or Slack" omits WhatsApp (`how-to/index.md:14`).
- The browser-target skill uses `targets list --kind browser` (`SKILL.md:21,72`); `man targets`
  has no `--kind` flag (`man-pages.ts:165-167`). Already recorded separately as the browser
  discovery bug.

## 5. GSV traces

Full lists with the sentence for every occurrence, two buckets, and the rerunnable count script
are in `gsv-traces.md`. Summary by surface:

| Surface | Brand prose (bucket A) | Identifiers the user still sees (bucket B) |
|---|---|---|
| Ship Manual | 5 sentences: "Save useful files to GSV" (`devices-workplaces/index.md:10`), "Run GSV management commands on `gsv`" (×2), "a GSV repository", "Keep working notes in GSV" (`manual/pages/devices-workplaces/cloud-computers.md:31,66,86`; `manual/pages/reference/shell-codemode-network.md:18`); plus the deliberate "Ship And The GSV Runtime" heading and rule (`orientation.md:82-84`) | stale `gsv.space` ×3; `%USERPROFILE%\GSV`; `gsv-manual` id read aloud; `gsv-contact-v1:` invite codes; `gsv` target in prose ~30×; `gsv` CLI; `gsvd`; `.gsv` paths |
| Instrument web UI | none rendered; stale comments claim "(N) GSV" tab titles and a "GSV" galaxy glyph that no longer exist | "the default is the GSV folder in your user profile" (`DesktopMachineSetup.tsx:113`, real folder name); `@gsv`, `{user}@gsv $`, "Delete x from gsv?", `gsv pair`; two `github.com/deathbyknowledge/gsv` links; `gsv.wiki` manifest kind; `~/.gsv/uploads` paths |
| Docs site | 111 outside code fences, 104 on architecture/reference pages (headings "GSV Desktop", "What GSV Does Not Protect Against", "Contacts And Cross-GSV Requests"; "GSV is a personal cloud computer"); 7 on user pages, 3 deliberate | `@GSV` Slack mention (`how-to/messengers.md:70,75`); route `/how-to/operate-gsv`; `gsv.space`; `GSV_*` env vars in deploy and install pages; nav "Ship" link → GitHub `gsv` |
| Extension | "Your GSV" ×2, "GSV Viewer", "GSV Browser Target Recorder" (`<title>`s); "gsv" fact label uppercased by CSS | `gsv-pair1_` placeholder |
| Adapters | ~38: every pairing reply ("In GSV, open Settings → Messengers → …"; "Connect this … identity to your GSV"), media rejections ("GSV Telegram could not receive…"), "GSV for Slack", "*From @user's GSV:*", WhatsApp Meta template "Your GSV has an update…", "Reach your personal GSV from Slack" | Slack app and bot name `GSV` → `@GSV`; internal `[gsv-…-controls]` markers in stored text |
| Accounts | admin `<title>` "· GSV registry" (`admin/page.ts:19`) under header "Ship administration" | – |
| CLI | "Pair this computer with one invitation from GSV" (`cli.rs:34`); "GSV Desktop" (`cli.rs:98`); "GSV Desktop is already running"; "GSV configuration directory is unavailable"; Windows uninstall text | `GSV_URL`, `GSV_TOKEN` in help; `GSV_GSVD_PATH`, `GSV_DESKTOP_PATH`, `GSV_VERSION=` in output; `GSV.app`; `%ProgramData%\GSV`; `gsv-cli@{os}` token label; `space.gsv.desktop` bundle id; `gsv$` shell prompt |
| Desktop | "Dictate into GSV using local speech recognition." (`host/apps/desktop/Info.plist:4`); packaging CFBundleName "GSV" (fallback for locales without an lproj) | – |
| Machine daemon | ~13: "GSV {} is available because {}…", "Installing GSV {}…", "GSV {release} was not installed…" (`device/mod.rs:1101-1479`); "The machine is connected to GSV." (`control.rs:160`); "GSV machine driver daemon", "local GSV configuration" (`app.rs:11,21,25`). The CLI's own hint already says "Ship {} is available". | `gsvd`; `~/GSV` default Windows workspace |
| Prompts and skills | ~25: "GSV's first-boot onboarding guide" (`tasks/setup-assist.md:1`); "GSV is your persistent home…" (`ship/context.d/00-role.md:7`); "Save needed files to GSV" (`05-targets.md:14`); "GSV Web Desktop", "this GSV client" (`context-origin.ts:37,49,91`); skill descriptions "Use GSV's browser capability", "Read and analyze images on GSV", "GSV delegation", "reusable GSV agent workflows"; "open Your GSV from the toolbar" | `[GSV EVENT]` marker; `GSV_MESSAGE` heredoc; `$GSV_PID`; `gsv-manual`; commit author `@gsv.local` in home repos |
| Man pages and tools | 22 in man pages ("GSV filesystem files", "this GSV's own mailbox", sample `mail send … 'Hello from GSV'` the agent may copy into real mail, "GSV Manual"); "Run a GSV shell command" (Send tool); "the live GSV capability manual" (Shell tool) | `GSV(1)` / `man gsv` |

The AGENTS.md rule keeps `gsv` as the runtime, target, CLI and path name. Every bucket B item is
compatible with that rule; every bucket A item is not. Three bucket A groups deserve their own
decision because they are not free to change: the WhatsApp Meta template (re-approval), the Slack
app and bot name (`@GSV` is what users type), and the macOS bundle name `GSV.app` (kept on purpose
per `host/packaging/macos/README.md:5`).

## 6. Localization readiness

> **Addendum, 2026-10-21.** After this audit was taken (main 4a4cf996e), PR #475 (merged 2026-10-20)
> moved nearly every web interface string into a catalog: `web/src/app/i18n/en.ts` (2,241 keys) with a
> Spanish `es.ts` carrying the same keys, a small runtime (`t`, `useT`, `rich`, plurals through
> `Intl.PluralRules`), `<html lang dir>` handling, and on-demand loading of non-English catalogs.
> The "Instrument web UI" findings below therefore describe the state before that change: raw ids
> in the Settings rail, `+ "s"` plurals, fragment assembly and CSS casing were largely addressed by
> it. Still true for the web after #475: `ZenMedia.tsx` formats with `en-US`, dates follow the
> browser rather than the owner's language, handles and slugs are ASCII-only, voice is English and
> Spanish only, and model-facing prefills stay English by design. Literals that still bypass the
> catalog after #475: the keyboard-help panel's view names "Chat" and "Fleet" and its "Fleet"
> heading (`web/src/app/features/instrument/Instrument.tsx:319-320,361`), the header's printed view
> id for Fleet (`shared/InstrumentHeader.tsx:41,56`), and the personal row label "ship" in the
> Fleet table and inspector (`fleet/Fleet.tsx:379,566`); "Chat" is kept as a name by the catalog's
> convention, and the Fleet and "ship" literals are moved to the catalog or capitalised by the
> `glossary-web` pull request. The other surfaces (manual, docs, extension, adapters, Accounts, host
> apps, prompts) are unchanged.

Structural facts that will shape the translation-key work, by surface. All are cited in
`term-inventory.md` section 6 per surface.

**Everywhere**

- At the time of the audit, no i18n scaffolding on any surface: no catalog, no `t()` helper, no
  `_locales`, no VitePress `locales`, no Fluent/gettext in Rust; every string was an inline literal.
  Since #475 the web app is the exception (see the addendum above); the other surfaces still hold.
- `lang="en"` is hardcoded in `web/index.html:2`, every extension HTML page, every Accounts page.
- The owner's "Response language" preference (`users/{uid}/locale/language`) steers only the
  agent's replies; `settings/README.md:15` says so. No surface formats dates or numbers by it.

**Instrument web UI**

- Raw ids rendered as labels: the Settings rail (`Settings.tsx:28,59`), the mobile header view id
  (`InstrumentHeader.tsx:32`), Plans tabs and back button (`ChatActivity.tsx:61-65`), place Kind
  (`Fleet.tsx:331`), receipt states, provider ids, messenger names title-cased from adapter ids
  ("Whatsapp", `consoleFormat.ts:13`).
- Keyboard shortcuts are English initials c/f/m/p/s (`InstrumentHeader.tsx:43-52`).
- Hardcoded locale: `toLocaleString("en-US")` (`ZenMedia.tsx:25`), `Intl.DateTimeFormat("en-US")`
  and an English `MONTHS` array (`zenModel.ts:600,614,636`), `"en"` timezone validators
  (`Timezone.tsx:17`, `routineModel.ts:52`), hand-built relative time and USD formatting in Fleet.
  About twenty `toLocale*()` calls use the browser default.
- Plurals by `+ "s"` or ternary (`zenModel.ts:592-594`; `ContactNotice.tsx:88`;
  `InviteContact.tsx:97`; `Responsibilities.tsx:72`); "{N} minutes remaining" never singular.
- Sentences assembled from fragments: activity and receipt lines, "from your memory: " + list,
  `in`/`on` chosen by `target === "gsv"` (`callDescription.ts:24`), every ledger phrase
  (`ledgerLabels.ts`), the consent sentence (`PolicyLinks.tsx:18-20`), "{meta} · {title}" step
  titles split on the last " · ".
- Casing from CSS (`instrument.css:203,397`, `settings.css:27`) and hand-typed ALL CAPS.
- English strings persisted or sent: "Ship included" stored as a model label, "## Pages" written
  into wiki files and parsed back by regex (`libraryService.ts:631`), prompt prefills inserted
  into the user's own message ("Use this file as context: @gsv …").
- English regexes over server text for error classification (`errorPresentation.ts:103-114`) and
  signup errors (`OwnerWelcomeScreen.tsx:75`).
- Text on canvas and in SVG: glyph reveal paints Latin noise glyphs (`glyphReveal.ts:119-136`);
  ASCII scenes with aria "Your Ship"; SVG `<text>` in IconButton.
- Handles, target ids and Memory slugs are ASCII-only; non-Latin input is dropped
  (`devicePairing.ts:46-51`, `deviceId.ts:3`).
- Voice is limited to English and Spanish by design (`speechText.ts:4-7`).

**Ship Manual**

- Hard-wrapped Markdown: lines break mid-sentence, so extraction must segment by paragraph.
- Anchors derive from English headings and are cross-linked (`#delegating-a-bounded-task`,
  `#password-recovery`, `#tool-approval`).
- The agent searches it in English (`wiki search "connect telegram" --prefix gsv-manual`,
  `man --search -- "send a photo"`).
- UI paths are arrow-joined label chains that must match the localized UI exactly ("Settings →
  sign-in → Account recovery → set up recovery"), and RTL needs mirroring.
- Quoted product strings must stay in sync with the product ("I wrote a reply but did not send it.
  Ask me again.", "I'm done — resume Ship", "Welcome to Ship").
- English tokens users type or read as values: `/link`, `/ship`, `/where`, handling values
  `manual` / `ship`, policy enums, outcomes `ok/failed/denied/cancelled`.
- One file serves two audiences: second-person text for the person is interleaved with
  directives to the agent ("Send the returned action URL to the person and yield").
- Numbers baked into labels: "N ongoing", "Fallback 1, and so on", "Include last 20 Ship messages".

**Docs site**

- No `locales` config; nav, sidebar and site description are inline English in
  `docs/.vitepress/config.ts`; `NavTitle.vue` hardcodes "Ship | documentation".
- Deep links depend on English auto-slugs; six pinned anchors still say "space".
- The docs-currency tooling (`tools/docs/coverage-map.json`, `check-docs-publishable.mjs`) maps
  source paths to English pages and scans with English-only patterns.
- Product-name wordplay that will not translate: "Ship ships with access to Cloudflare's models",
  "Why 'Ship'?" (General Systems Vehicles), "your devices are the crew".

**Extension, adapters, Accounts**

- The extension has no `_locales/` and no `__MSG_*__` keys; store name and description cannot be
  localized as-is.
- Adapters ignore the provider's user language (no `language_code` handling); every reply is
  English regardless of the owner's preference.
- Provider-bound strings need provider-side work per language: the WhatsApp Meta template body
  and "Show me" button (one language per deployment via `WHATSAPP_TEMPLATE_LANGUAGE`; re-approval
  per change), the Slack app manifest (single-locale), and pairing keywords matched as English
  regexes (`/link`, `pair`, `link`). WhatsApp button titles are truncated by code point, so long
  translations are cut silently.
- Accounts pages are server-rendered template literals with no extraction point; `/owner/api`
  forwards English error messages and routes on prefix matches, so translating those messages
  changes control flow (`owner-api.ts:79-83`, `admin/http.ts:147-150`).
- Verification email splices `purpose` into "Your Ship {purpose} code" (`owner-verification.ts:12-14`).
- Admin shows raw lifecycle enums as badges and in sentences ("Lifecycle controls are unavailable
  while this Ship is {state}.").
- Dates: `Intl.DateTimeFormat("en", …)`, `toLocaleString("en-US")`, `toUTCString()`.

**Host apps**

- clap derive help is compile-time; swapping it needs builder-style help or a Fluent layer.
- Desktop errors cross IPC as finished English `String`s (`Result<_, String>` on every Tauri
  command); the web UI shows them verbatim. `voice_error_message` (`input.rs:761`) is the one place
  with an enum code and is the pattern to generalize.
- Daemon diagnostics are English sentences built from fragments and carried in
  `DiagnosticNotice.message`; only `code` is stable.
- Always-plural "{n} minutes"; Debug-printed enums as labels (`phase: {:?}`); keyboard mnemonics
  baked into prose ("Approve [o]nce, [a]lways, or [d]eny?").
- Windows SCM display name and description and Wayland shortcut names are registered once at
  install and not updated on upgrade; macOS ships only `en.lproj` with base CFBundleName "GSV";
  the Windows installer is English-only.
- Speech output accepts only `en` and `es` and reports a wrong error for other languages
  (`speech.rs:39`).
- "My computer" default label is persisted in the install-time language.

**Prompts, skills, man pages**

- Language handling is one runtime fact (`Preferred language: {{user.language}}`,
  `00-runtime.md:11`) plus one rule in `ship/context.d/05-voice.md:7`. Crew and the setup helper
  have no language rule.
- `CORRECTION_FAILURE_NOTICE` ("I wrote a reply but did not send it. Ask me again.",
  `workers/gateway/src/process/internal/lifecycle.ts:121`) reaches the person verbatim in English without passing through the
  model.
- The welcome script is English sample text with idioms the agent reuses (`welcome.md:21,47,49`).
- Prompts quote English UI labels the agent repeats: "your cloud", "Settings, messengers",
  "Settings, mcp" (`welcome.md:93-94`), "I'm done — resume Ship" (browser-target skill), the stale
  "Your GSV".
- Skill descriptions are the catalog text the model and change events carry; editing a shipped
  skill means adding a previous-hash entry (`builtin-skills.ts:66-114`), so localizing skills is a
  migration, not a text change.
- Prompt content is protected (AGENTS.md); any change here needs explicit authorization.

## 7. Open decisions

Places where the audit shows the conflict but choosing the canonical term is a product call.

1. **May "Ship" mean both the agent and the hosted instance?** Today it does, everywhere
   ("Create your Ship" then "Message your Ship"). If yes, the other instance words (space,
   installation, gateway, deployment) need to retreat to operator and technical surfaces, and
   "My Ships" stands. If no, the instance needs its own user-facing noun. Related: whether the
   desktop app, the extension, the CLI and the messenger bot may also be called plain "Ship".
2. **The connected machine**: place, computer, machine or device? The UI leans "place" for the
   list and "computer" for the act of connecting; the manual uses "computer" overwhelmingly; the
   docs and CLI use "device" and "machine". The browser is also a place. One noun for the list and
   one verb phrase for connecting would resolve S2.
3. **The `gsv` target**: "your cloud" is the UI's choice and the manual's bold label. The
   alternatives in circulation (cloud home, Ship computer, Ship itself, the installation itself,
   GSV) should collapse onto it or onto a replacement. Whether `@gsv` may stay visible in the
   picker is a separate call tied to the AGENTS.md rule.
4. **Ongoing work**: responsibilities vs plans vs ongoing vs routines. The panel is "Plans", its
   sections "Responsibilities" and "Routines", the button "{N} ongoing", the settings tab
   "standing". The prompts avoid all of these and say "reminder or recurring task". One
   user-facing noun for a responsibility and one for a routine, with "standing" reserved for one
   sense only, would resolve S4 and D3.
5. **Knowledge**: Memory vs wiki vs collections vs knowledge. The view is "Memory", the empty
   state says "personal wiki", the tabs say "Collections", the prompt H1 says "Knowledge".
6. **Messaging**: messenger (UI, manual, sidebar) vs adapter (CLI, architecture docs, the
   adapter-model page's explicit preference). The CLI command `gsv adapter` and the doc sentence
   at `adapter-model.md:65` are the two places that would change if "messenger" wins.
7. **The ledger**: Logs (UI, manual page title) vs ledger (manual index, docs sidebar, prompts).
   And whether "ledger" may continue to name the responsibility store as well.
8. **Non-Ship agents**: helper vs process vs agent vs Crew. Crew is a concept the UI never
   surfaces; either it appears in the UI or the manual and docs stop using it with users.
9. **Root**: root vs admin vs administrator. The login toggle says "admin", the heading
   "ADMINISTRATOR SIGN-IN", recovery says "root password", Accounts says only "administrator".
10. **Approval verbs**: one vocabulary across Permissions (Allow / Ask / Block), the approval
    card (run it / don't / always allow) and the messenger buttons (Approve once / Always approve
    / Deny), and whether "Always" means forever or this conversation.
11. **Names that exist only in documentation**: Instrument, Fleet-as-a-word, Zen, Crew. Either
    the UI shows them or the documentation stops relying on them.
12. **Provider-bound GSV identifiers**: the Slack app/bot name `GSV` (users type `@GSV`), the
    WhatsApp Meta template, `GSV.app` and `gsvd`. Each has a cost to change that the AGENTS.md
    rule does not settle on its own.
13. **The manual's domain**: `gsv.space` appears three times in the pinned manual against
    `ship.space`; one is the extension download link the agent shares.
14. **Casing policy**: the UI's lowercase-label convention is implemented in CSS and does not
    carry over to languages where nouns are capitalised or scripts without case. Whether the
    convention survives localization is a design call that affects every key.

## Next steps this audit enables

- A glossary with one canonical user-facing term per concept and its approved synonyms per
  surface, derived from the decisions above.
- Rename passes per surface (adapters first: they are the only surface where "GSV" is still the
  brand in front of users), each against the glossary.
- The translation-key structure: one key per concept-in-context, informed by sections 4.2 and 6
  (words with several senses need several keys; fragments need whole-sentence keys).
- Manual and docs restructure so that link text, H1 and the UI label for a view agree, and so
  the manual's tree can be navigated from the five views.
