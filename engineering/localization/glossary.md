# Ship glossary

Canonical customer-facing terms, decided 2026-10-20 (round 1). One term per concept, one
definition, and the words it replaces. Applies to the web app, signup, Ship Desktop, the Ship
extension, messenger replies, Accounts pages, the manual, the user docs, and what Ship says.
Developer and operator vocabulary is out of scope unless noted.

Source: `ia-audit.md` and `term-inventory.md` in this folder. Round-2 items are listed at the end.

## Terms

| Term | Definition | Replaces |
|---|---|---|
| **Ship** | The product, the agent you talk to, and its home, as one thing. "Ship is an AI assistant that can use your computer and connected services to get things done." | personal intelligence · personal agent · your agent(s) · installation · space · gateway · deployment · "personal AI computer" · "cloud computer" (for the product) · lowercase "ship" |
| **your Ship** | Ship as it belongs to one person. | your personal Ship · your agent · your installation · your space |
| **handle** | Your Ship's name and address: `@name`, living at `name.domain`. (Email is the separate, optional mailbox term below.) | Ship address · GSV address · profile address · public address |
| **your account** | The person's account on their Ship. | personal account · owner (except on Accounts/operator pages) · Your session · username |
| **administrator** | The separate sign-in with full control of a Ship. Short form "admin" on the login toggle only. | root · administrative login · root password ("administrator password") · root credentials ("administrator credentials") |
| **operator** | The organisation that hosts your Ship. Use its name where known ("Humans & Machines"); "operator" is the fallback word. | hosting operator · installation operator |
| **Chat** | The view where you talk to Ship. A "conversation" is what is in it. | Zen · console |
| **Messages** | What you or Ship deliberately sent in Chat. | sent messages · deliveries |
| **helper** (plural **Helpers**) | A separate piece of visible work Ship runs for a task, with its own activity and controls. An interactive helper also has its own conversation; a scheduled or handed-off helper runs without one. "Ship and its helpers" when both are meant. | process · Processes · work item · Work Session · work session · work process · task · worker · Crew · delegated child · your agent(s) · [WORK SESSION] |
| **Send** | Ship's tool for replying; the name stays as is (Steve: it is a tool name, renaming has no benefit). "send" as a plain verb in prose is fine. | – |
| **Logs** | The record of every action Ship took: who asked, where it ran, what it did, why, and how it ended. Its table is "Actions". | ledger · the ledger · action history · action records · Syscall history |
| **routine** | Something Ship takes care of regularly. "Reminder" is fine in plain speech for a one-off. | schedule · scheduled task · Custom schedule · automation · recurring job · recurring task · cron |
| **hand off** | The verb for Ship giving a bounded task to a helper. No noun. | delegation · delegate (noun uses) · Crew delegation |
| **connection** (plural **Connections**) | A computer or browser you have connected to your Ship. | place · Places · target · Target ID · device · machine · node · laptop |
| **computer** | A connection that is a computer. | machine · device · laptop · server (as a kind) |
| **browser** | A connection that is a browser, either your own through the Your Ship extension or a cloud browser. | browser target · browser profile |
| **connect** | The verb for adding a connection or a messenger. Panel titles match the button that opened them. | pair · pair again · enroll · link (for messengers) |
| **Ship's home** | Where your Ship lives and keeps its files; always on. | your cloud · Your cloud home · the cloud home · Ship computer · Ship itself · the installation itself · the gateway's own filesystem · cloud filesystem · native cloud target |
| **cloud computer** | An on-demand Linux computer Ship can start for documents, data, media and software. | cloud instance |
| **cloud browser** | An on-demand browser Ship can start and manage, even while your own devices are offline. | (already consistent) |
| **Your Ship** (the extension) | The browser extension that connects your browser to your Ship. The name stays "Your Ship" on purpose: Chrome's banner then reads `"Your Ship" is debugging this browser` while Ship is using it (Steve). | Your GSV · GSV Viewer · "the Ship extension" |
| **the web app** | Ship in your browser. Not given a product name. | Instrument · web console · web UI · web application · Instrument UI · the console |
| **Ship Desktop** | The desktop app. "the desktop app" in prose. | GSV Desktop · the beta desktop app · Desktop application · GSV.app (in prose) |
| **Work** | The view that holds Connections and the Ship-and-helpers table (Ship's own row sits there too, so the section is headed "Ship and helpers"). Nav key `w`. | Fleet · Machines console · operational view |
| **Memory** | The view for what Ship has learned about you. (Its inner vocabulary is round 2.) | – |
| **People** | The view for conversations and contacts across Ships. | – |
| **Settings** | The settings view; each section's rail label equals its heading. | configuration · config (in customer text) |
| **MCP servers** | The Settings section for connected MCP servers. The name stays, since that is all the section holds and people who know what an MCP is should find it (Steve). The rail label matches the heading. | mcp (as the rail label) · Integrations · MCP connections · connected services |
| **create** your Ship | Signing up. | sign up · registration · register |
| **activate** | Finishing first boot of a new Ship. | set up · setup · onboarding · first-run setup · Continue setup · Finish setting up |
| **sign in** | Entering your Ship. | log in · login |
| **Account recovery** | The feature for getting back in. "reset your password" is the act. | Recovery email · Recover your Ship · Recover a Ship · Recover access · Password recovery · owner recovery |
| **messenger** | A messaging app connected to your Ship (Telegram, WhatsApp, Discord, Slack). | adapter · channel · messaging connection · messenger link · messaging identity · surface · bot (as the concept) |
| **your Telegram account** (etc.) | The account on a messenger that you connect to your Ship. | identity · Telegram identity · messaging identity |
| **code** | What you paste to connect a messenger or a computer. | pairing code · link code · one-time link code |
| **your Ship's email address** | The mailbox your Ship has of its own, when the operator provides managed mail; it uses the handle at the operator's mail domain, which may differ from the Ship's hostname domain. | mailbox · managed mail address |
| **contact** | A person on another Ship you are connected with, identified by their handle. | Contact (capitalised as a term) · connection (for a person) · relationship |
| **request** | A message request: someone asking to talk. Only this sense. | Work requests · approval request · composer request · cross-Ship request (round 2 for the others) |
| **Instructions** | The Settings section holding your standing instructions to Ship and its helpers, in Markdown. | standing context · standing instructions (as a heading) · context files · context.d · personal context · user context · Program context · Home context |
| **skill** | A reusable procedure Ship loads for relevant work. Manual only. | – |
| **Permissions** | The Settings section that decides when Ship asks before acting. Rules are **Allow / Ask / Block**. Cards and messenger buttons are **Allow once / Always allow / Block**. Today "Always" remembers the rule for the requesting Ship or helper on that target, and the interface says so; making it account-level is HAM-1099, after which the wording follows. | approval policy (as a heading) · auto / ask / deny (shown values) · run it / don't / always allow · Approve once / Always approve / Deny · "Approved for this conversation." |
| **capability** | A kind of action Ship may be allowed to take. Used inside Permissions; elsewhere "what Ship can do". | – |

## Reverted after Steve's review

- **Send** keeps its name (tool name; no benefit in changing it).
- The extension keeps the name **Your Ship** so Chrome's debugging banner reads naturally.
- The **MCP servers** section keeps its name; only the rail label aligns with the heading.

## Follow-ups recorded with the decisions

- **Administrator flow.** The rename does not fix the underlying problem: people do not understand
  what the admin sign-in is for. The sign-in toggle, `/recover`, Settings › Sign-in and the
  Accounts recovery pages need design work as a flow, not just new words.
- **Fleet → Work** changes the nav key (`f` → `w`), the extension's "open Fleet and choose
  Connect", the manual's Fleet references, and the docs.

## Round 2 and postponed

| Concept | Status | Note |
|---|---|---|
| Activity (one sense; Logs dialog, context-bar aria, Feedback wording, LAST ACTIVITY) | postponed | |
| A responsibility (plans / ongoing / responsibilities) | round 2 | "Plans and open work?" Now that **Work** is a view name, "open work" inside Chat would point at the view. |
| Standing responsibilities (Settings › standing) | round 2 | "would 'work' fit?" Same collision. |
| The command-line tool (`gsv`) | postponed | |
| Invitations and requests (people / device / setup; 7-day vs 1-hour) | postponed | |
| Memory's inner vocabulary (wiki / collections / library / knowledge) | postponed | |
| Words to reserve for one sense (standing, place, request, invitation, connect, session, workspace, identity, Activity, memory, Today, voice, Work, profile) | round 2 | after the two rows above settle "work" and "standing" |
