import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_FLOWS,
  ARCHITECTURE_SUBSYSTEMS,
} from "./architecture.mjs";

const SYSTEM_COPY = {
  gateway: {
    plainLabel: "FRONT DOOR",
    summary: "Every visit starts here. It finds the right GSV home and stops unknown or inactive visits before they reach anything private.",
    owns: ["Find the right GSV home", "Open only approved doors", "Keep different GSV homes apart"],
    boundary: "It chooses the right home and the right door. It does not decide what a person is allowed to do inside.",
    invariant: "A visitor can never choose someone else's private GSV home.",
    components: {
      "edge-router": ["SORT INCOMING VISITS", "Figures out what each visit is for and sends it to the right place.", "It keeps apps connected, completes sign-in, and moves project history.", "If it cannot find a known destination, it stops there."],
      "installation-routing": ["FIND THE RIGHT GSV", "Turns a web address into the private GSV home it belongs to.", "It checks a trusted address book first.", "People on the internet cannot choose a private home number themselves."],
      "installation-storage": ["KEEP HOMES APART", "Adds the right home number whenever saved information is opened.", "It keeps one GSV home's files away from every other home.", "The file tools still feel the same wherever the information is stored."],
      "service-entrypoints": ["TRUSTED SERVICE DOORS", "Lets approved message and email services enter through small, locked doors.", "The setup decides which service belongs at each door.", "If a handoff fails, it stops so nothing is left hanging."],
    },
  },
  kernel: {
    plainLabel: "TRAFFIC CONTROLLER",
    summary: "This is GSV's rule keeper and switchboard. It checks who is asking, what they may do, and where the work belongs.",
    owns: ["Check who is asking and what they may do", "Send work to the right place", "Start, stop, and schedule agents"],
    boundary: "It coordinates work. It does not think for the agent, draw the screens, or do heavy work on your computer.",
    invariant: "A connection alone never gives permission. The person and their permission must be checked every time.",
    components: {
      "kernel-do": ["MAIN COORDINATOR", "Keeps the saved rules and lists needed to run one GSV home.", "It handles one change at a time so two updates cannot scramble each other.", "It gives each helper only the information needed for that job."],
      "identity-policy": ["CHECK PERSON + PERMISSION", "Works out who is asking and whether they may touch this exact thing.", "Signing in proves who the visitor is.", "What they may do is checked again for the chosen agent, file, tool, or project."],
      "dispatch-routing": ["SEND WORK TO THE RIGHT PLACE", "Chooses where an approved piece of work should happen.", "It can choose GSV itself, your computer, or your browser.", "It closes the path when the work ends, fails, times out, or is cancelled."],
      "process-control": ["START + STOP AGENTS", "Keeps track of working agents and their schedules.", "Starting, pausing, clearing, and ending an agent are different choices.", "Once an agent is fully ended, its number is never given to a replacement."],
      "delivery-coordination": ["DELIVER UPDATES + REMEMBER PROMISES", "Gets visible replies to the right screen or messaging app and remembers unfinished promises.", "Private drafts never count as sent messages.", "A reply arriving late cannot change newer work."],
      schema: ["SAVED CONTROL INFORMATION", "Records how the controller's saved information is organized.", "Changes are added in a clear order so older GSV homes can be updated safely.", "The saved rules are not secretly changed while the program starts."],
    },
  },
  process: {
    plainLabel: "WORKING AGENT",
    summary: "One agent works here. It keeps its private work, waiting messages, tool results, and stop controls safe across restarts.",
    owns: ["One agent's private work", "Waiting messages and tool results", "Stopping and ignoring late work"],
    boundary: "It owns private work, not the shared message history and not anyone's permission.",
    invariant: "Old or cancelled work can never change the agent after newer work has started.",
    components: {
      "agent-loop": ["THINK + ACT", "Builds the agent's reading material, asks the AI for the next step, uses tools, and continues until the job is done.", "Only one turn moves forward at a time.", "New messages, stopping, and tool results remain available while it works."],
      "process-store": ["PRIVATE WORK RECORD", "Saves the agent's private notes, waiting input, tool work, and current state.", "It can recover after the program sleeps or restarts.", "It keeps private work separate from messages people can see."],
      "context-epoch": ["STARTING INSTRUCTIONS", "Freezes the exact instructions and starting facts used for a stretch of work.", "Later changes arrive as dated updates instead of rewriting the past.", "A fresh start closes and saves the old set first."],
      "tools-approvals": ["TOOLS + YOUR APPROVAL", "Keeps tool requests, results, and questions that need a person's approval paired correctly.", "A tool result always matches the request that created it.", "Stopping work finishes or safely cancels every unfinished tool request."],
      codemode: ["MULTI-STEP WORK", "Lets the agent write a small program that combines several approved actions.", "It uses the same permission checks as every other tool.", "It cannot invent a new power or quietly reach outside the agent's allowed area."],
      "process-media": ["ATTACHED FILES", "Keeps pictures, audio, and other attachments for this agent without copying them into every message.", "Temporary items belong only to this agent.", "Saved messages point to one lasting copy when the file must remain available."],
    },
  },
  conversation: {
    plainLabel: "MESSAGE HISTORY",
    summary: "This is the official conversation people can see. It contains sent messages and lasting file links, never private reasoning or unfinished drafts.",
    owns: ["Messages people can see", "The order of those messages", "Lasting links to shared files"],
    boundary: "It records visible messages. It does not run the agent or store the agent's private work.",
    invariant: "A message already saved never changes, and older messages always stay before newer ones.",
    components: {
      "conversation-do": ["MESSAGE BOOK", "Keeps the official message order for one conversation.", "It accepts only approved additions.", "It saves the message; the traffic controller separately tells open screens that the conversation changed."],
      "message-store": ["RECENT MESSAGES", "Keeps the newest messages close at hand for quick reading.", "Messages are numbered in order.", "Removing an agent does not remove the shared conversation."],
      "archive-retention": ["OLDER MESSAGES", "Moves older message groups into a lasting saved place without changing them.", "A simple list shows where each older message is stored.", "Cleanup removes only information that is safely kept elsewhere or truly expired."],
      "resource-references": ["FILE LINKS", "Keeps stable links to pictures, audio, and files used by a message.", "The file is saved once instead of copied into every record.", "A short-lived file is made lasting before a message points to it."],
    },
  },
  protocol: {
    plainLabel: "SHARED RULES",
    summary: "These are the shared rules GSV parts use when they ask each other for work. Following the format never gives permission by itself.",
    owns: ["The shape of a request and reply", "The agent's small tool list", "The same behavior in every work place"],
    boundary: "It describes how parts communicate. It is not a running part and cannot approve anything.",
    invariant: "A familiar-looking message or tool name never proves who sent it or what they may do.",
    components: {
      "wire-frames": ["MESSAGE LABELS", "Defines the small labels that explain who a message is for and what kind of message it is.", "Large files travel separately instead of being squeezed into the labels.", "One part stays clearly responsible for each accepted file until it is used, passed on, or cancelled."],
      "model-tools": ["AGENT'S BASIC TOOLS", "Keeps the agent's main choices small: read, write, edit, delete, search, run a typed instruction, or combine steps.", "New abilities appear underneath these choices instead of adding endless buttons.", "The tool name does not decide permission."],
      "process-frames": ["AGENT WORK INSTRUCTIONS", "Defines the messages used to start work, add input, report progress, stop, clear, or end an agent.", "Every note says which agent and piece of work it belongs to.", "Stopping and clearing remain different actions."],
      "syscall-reference": ["SAME RULES EVERYWHERE", "Explains what files, typed instructions, website access, agents, and messages should do wherever they run.", "The same action should mean the same thing in GSV, on a computer, or in a browser.", "A place may leave out an action it cannot honestly provide."],
    },
  },
  "native-target": {
    plainLabel: "BUILT-IN WORKSHOP",
    summary: "This is GSV's built-in place for approved file work, one typed instruction at a time, and website requests.",
    owns: ["GSV files and folders", "Short typed-instruction jobs", "Approved website requests"],
    boundary: "It does the work it is given. The traffic controller still decides who may ask for that work.",
    invariant: "Its file, typed-instruction, and website actions mean the same thing as those actions in other work places.",
    components: {
      "target-provider": ["BUILT-IN WORK RUNNER", "Offers GSV's built-in file, typed-instruction, and website actions.", "It reports only actions it can really perform.", "The traffic controller checks permission before work reaches it."],
      "gsv-fs": ["GSV FILES + FOLDERS", "Presents saved information as familiar files and folders.", "Home folders, system views, project history, and ordinary saved files are joined behind one view.", "The person or app does not need to know where each file is kept."],
      "worker-shell": ["ONE TYPED INSTRUCTION", "Runs one small computer instruction and returns what happened.", "It handles one instruction, not every kind of job a full computer can do.", "Longer computer jobs belong to a connected computer."],
      "native-network": ["WEB REQUESTS", "Makes approved calls to websites and online services.", "It follows the same stop and cleanup rules as other work.", "It does not become a general doorway around permission checks."],
    },
  },
  inference: {
    plainLabel: "AI CONNECTION",
    summary: "Connects a working agent to the chosen AI service, carries one answer back, and stops that request cleanly when needed.",
    owns: ["One live AI request", "AI choices and settings", "Speech and picture requests"],
    boundary: "It carries one AI request. The working agent keeps the lasting work record.",
    invariant: "Stopping the agent also stops the live AI request that belongs to it.",
    components: {
      "inference-service": ["AI REQUEST MANAGER", "Turns one agent request into one live AI answer.", "It sends text and approved attachments to the chosen service.", "It owns stopping, timing out, and cleaning up that live request."],
      "model-registry": ["AI SETTINGS", "Combines built-in AI choices with the owner's saved choices.", "The same list is used when showing choices and when starting work.", "Missing or changed settings fail clearly instead of silently choosing something else."],
      providers: ["AI SERVICE CONNECTIONS", "Connects to the supported AI companies.", "Each connection handles that company's sign-in and message differences.", "Those differences do not leak into the working agent."],
      "media-inference": ["SPEECH + PICTURES", "Handles speech-to-text, text-to-speech, and picture creation.", "Large files stay outside small control messages.", "The part that accepts a live flow of information must finish or cancel it."],
    },
  },
  sdk: {
    plainLabel: "APP BUILDING KIT",
    summary: "Gives app makers a ready-made way to connect to GSV and use its shared actions without rebuilding the plumbing.",
    owns: ["A ready-made GSV connection", "A list of available actions", "Helpers for files and media"],
    boundary: "It makes communication easier. It does not sign people in or grant permission.",
    invariant: "The helper must keep the same meaning as the shared GSV rules underneath it.",
    components: {
      "typed-client": ["READY-MADE CONNECTION", "Opens a GSV connection and turns replies into useful app results.", "It keeps live updates and normal replies organized.", "The GSV home still checks every action."],
      "syscall-map": ["LIST OF AVAILABLE ACTIONS", "Lists the actions an app can ask GSV to perform.", "Each action says what information it needs and what answer it returns.", "Adding an action here does not automatically allow anyone to use it."],
      "frame-bodies": ["MESSAGES + LARGE FILES", "Keeps short instructions separate from large files.", "A large file can move a little at a time instead of being copied into a tiny message.", "The sender and receiver always know who must finish or cancel it."],
      "media-resources": ["FILE + MEDIA LINKS", "Gives apps small links to pictures, audio, and files.", "The file contents are loaded only when someone truly needs them.", "This avoids copying the same large item through every screen."],
    },
  },
  services: {
    plainLabel: "SERVICE INSTRUCTIONS",
    summary: "This shared instruction book explains how GSV talks to optional account, AI, email, and messaging helpers. The real helpers run separately.",
    owns: ["Rules for finding managed GSV homes", "Rules for first setup and optional hosted AI", "Rules for email and message bridges"],
    boundary: "These are instructions, not one giant service. Each real helper keeps its own records, while the private GSV home controls people and permission.",
    invariant: "Only an active, known GSV home may receive ordinary work.",
    components: {
      directory: ["GSV ADDRESS BOOK", "Matches a public web address to the correct private GSV home and its current status.", "Unknown addresses return nothing.", "Resetting a home gives it a new private number instead of reusing the old one."],
      "onboarding-entitlements": ["FIRST SETUP + AVAILABLE OPTIONS", "Explains how to create one new GSV home and list the optional features its hosting company makes available.", "A first-time setup key works for only one home.", "The private home creates its own lasting sign-in details."],
      "managed-inference": ["HOSTED AI ACCESS", "Explains how a hosting company can provide AI when that option is available.", "It covers asking for one answer, receiving it as it is made, and stopping it.", "The private home still decides which person or agent may ask."],
      mail: ["MANAGED EMAIL", "Covers receiving email, claiming a saved draft, recording what happened, and inspecting problems.", "It shares lasting references instead of trusting public sender details.", "It is separate from the message-bridge list."],
      "adapter-service": ["MESSAGE BRIDGE INSTRUCTIONS", "Explains the small doorway any messaging bridge must provide.", "The setup fixes the bridge's name and limits.", "Carrying messages and offering a place for tools to work remain separate jobs."],
    },
  },
  web: {
    plainLabel: "WEBSITE",
    summary: "This is the browser screen people use to chat, manage agents, inspect settings, and work with files.",
    owns: ["What appears in the browser", "Temporary screen state", "The signed-in browser connection"],
    boundary: "It shows controls and asks GSV to act. Hiding or showing a button is never the final permission check.",
    invariant: "The private GSV home checks every important action even if the website already checked it.",
    components: {
      "boot-session": ["OPEN + SIGN IN", "Starts the website, finds the correct GSV home, and restores a signed-in visit.", "First-time setup information is removed from the address bar before it is used.", "A failed sign-in never opens private screens."],
      "desktop-shell": ["APP WINDOW", "Provides the main window, navigation, panels, and pop-up areas.", "It keeps temporary layout choices in the browser.", "It does not become the owner of saved GSV information."],
      chat: ["CHAT + WORK VIEW", "Shows the personal conversation and clearly marked views of other working agents.", "Only messages that were truly sent appear as shared history.", "Opening another work view does not replace the personal agent elsewhere."],
      "system-console": ["SETTINGS + STATUS", "Shows accounts, agents, connected tools, schedules, and setup choices.", "It explains what is connected and what is allowed.", "Every change is still checked inside GSV."],
      "work-surfaces": ["FILES + TYPED INSTRUCTIONS + NOTES", "Lets people browse files, run approved typed instructions, and read saved knowledge.", "Each screen uses the same shared actions as an agent.", "The screen does not invent its own file or typed-instruction behavior."],
      "design-system": ["SHARED LOOK + FEEL", "Keeps colors, buttons, text, spacing, keyboard use, and screen-reader support consistent.", "Reusable pieces make similar actions look and behave alike.", "It owns appearance, not GSV's rules."],
    },
  },
  host: {
    plainLabel: "COMPUTER APPS",
    summary: "These are the GSV programs on your computer: the desktop app, text controls, the tool runner, and small voice or gesture helpers.",
    owns: ["The desktop app", "Approved work on your computer", "Voice and gesture help on your computer"],
    boundary: "Each program has one small job. The chat app does not secretly become the computer tool runner.",
    invariant: "A program proving its name does not give it permission to do everything.",
    components: {
      cli: ["TEXT CONTROLS", "Lets a person set up, inspect, and control GSV from a text window.", "It can manage the GSV programs running on this computer and connect to the private GSV home.", "It uses the same rules as the other apps."],
      desktop: ["DESKTOP APP", "Provides chat and work controls in its own computer window.", "It remembers drafts and what is open on the screen.", "It talks directly to GSV for chat instead of passing through the tool runner."],
      machine: ["COMPUTER TOOL RUNNER", "Runs approved file work, typed instructions, uploads, and downloads on the computer.", "It reports only the actions it can do.", "It is responsible for the job until it finishes, fails, or is cancelled."],
      "host-contracts": ["SMALL COMPUTER CONNECTIONS", "Defines the narrow conversations between GSV programs on the same computer.", "One connection handles desktop control and another handles the computer tool runner.", "Neither becomes a hidden shortcut around the private GSV home."],
      helpers: ["VOICE + GESTURE HELPERS", "Turns speech or gestures on the computer into small, useful results.", "Raw microphone and camera information stays on the computer.", "Only finished text or a simple action is sent onward."],
    },
  },
  adapters: {
    plainLabel: "MESSAGE BRIDGES",
    summary: "Four bridges carry messages between GSV and Discord, Telegram, Slack, or WhatsApp. Managed email is a separate service shown here beside them.",
    owns: ["The outside account connection", "Records that make delivery safe", "The different message style used by each app"],
    boundary: "A bridge carries messages. It cannot choose a GSV home or give itself more permission.",
    invariant: "An outside message is recorded before it causes work, and a reply is never carelessly sent twice.",
    components: {
      shared: ["SAFE DELIVERY RECORD", "Keeps a record of incoming events and outgoing deliveries.", "It remembers what has already been handled.", "Unclear delivery results are not blindly tried again."],
      discord: ["DISCORD", "Connects a Discord account to GSV.", "It turns Discord events into the common message shape.", "It formats GSV replies for Discord without moving Discord quirks into GSV's center."],
      telegram: ["TELEGRAM", "Connects Telegram chats to GSV, including hosted account-linking steps.", "A person must confirm the link while signed in.", "Delayed work checks that the link is still the same before acting."],
      slack: ["SLACK", "Connects a Slack workspace to GSV and can also offer Slack files and actions as a work place.", "Workspace setup and a person's confirmed link are separate steps.", "The person confirms their own link while signed in, and delayed work checks it again."],
      whatsapp: ["WHATSAPP", "Connects a WhatsApp account you run yourself to GSV.", "It turns incoming messages and files into the same simple form used elsewhere.", "Connection details and delivery differences stay inside this bridge."],
      email: ["SEPARATE MANAGED EMAIL", "Receives email and delivers drafts that GSV has already saved for sending.", "It records final and uncertain results so they can be inspected.", "It is not a chat bridge and is not in the message-app list."],
      "test-adapter": ["PRACTICE BRIDGE", "Provides a safe fake messaging app for automated checks.", "It follows the same doorway rules as real bridges.", "It never appears as a real public messaging service."],
    },
  },
  extension: {
    plainLabel: "BROWSER HELPER",
    summary: "This browser add-on gives an approved agent a separate place to work with browser files, tabs, and pages.",
    owns: ["The browser work place", "Page actions", "Control pages inside the browser"],
    boundary: "It performs approved browser work. It does not sign itself in or decide its own permission.",
    invariant: "A browser action runs only when both GSV and the browser helper agree it is allowed.",
    components: {
      "supervisor-driver": ["KEEP BROWSER TOOLS READY", "Keeps the browser work place connected and ready.", "It reconnects after short interruptions.", "It reports only the actions the current browser can really do."],
      "browser-fs-shell": ["BROWSER FILES + ACTIONS", "Presents browser information as familiar files and simple actions.", "The same action names keep the same meaning as other GSV work places.", "Browser-only limits remain honest and visible."],
      "page-automation": ["USE THE WEB PAGE", "Reads pages and performs approved clicks, typing, and navigation.", "It acts through the browser's own controls.", "Stopping the job also stops the page action it owns."],
      "browser-surfaces": ["BROWSER CONTROL PAGES", "Shows the browser helper's condition and setup screens.", "These pages stay on the person's browser.", "They cannot replace the private GSV home's permission checks."],
    },
  },
  ripgit: {
    plainLabel: "FILE HISTORY",
    summary: "Keeps version-by-version history for source folders and projects, so changes can be inspected and recovered.",
    owns: ["Project versions", "The files inside each saved version", "Safe all-at-once project changes"],
    boundary: "It keeps version history. Ordinary work folders use simpler saving unless they are deliberately placed here.",
    invariant: "Every project address includes the correct GSV home before saved information is opened.",
    components: {
      "worker-repository-do": ["ONE PROJECT HISTORY", "Keeps one project's files and change history together.", "Changes happen one at a time for that project.", "The project belongs to one GSV home and one named owner."],
      "git-protocol": ["SHARE CODE HISTORY", "Lets familiar project-history tools copy history in and out.", "It turns those requests into changes to the same saved project.", "The outside tool never chooses a different private GSV home."],
      "object-store": ["SAVED FILE VERSIONS", "Stores the file pieces used by project history.", "Repeated pieces can be shared safely instead of copied again.", "Missing or damaged pieces fail clearly."],
      hyperspace: ["CHANGE A PROJECT SAFELY", "Applies a group of file changes together and records the result.", "Readers see either the old version or the new version, not a half-finished mix.", "Each change leaves a history people can inspect."],
    },
  },
  deployment: {
    plainLabel: "SETUP BUILDER",
    summary: "Turns a chosen GSV version and message-app list into the separate online pieces needed to run it.",
    owns: ["The setup plan", "Ready-to-run copies of each program", "Connections between the online pieces"],
    boundary: "It builds and connects the pieces. Once GSV is running, it does not decide user permission or daily work.",
    invariant: "Each major piece is built separately and connected through an explicit, reviewable setup choice.",
    components: {
      "runtime-manifest": ["SETUP PLAN", "Lists the matching program pieces and optional parts for one GSV version.", "The choices are checked before building starts.", "A missing or mismatched piece stops the setup clearly."],
      "runtime-composition": ["CONNECT THE PIECES", "Creates the online helpers, saved places, web addresses, and private connections.", "Every connection is named in the setup.", "Nothing gains user permission merely because it was connected."],
      "adapter-catalog": ["BUNDLED MESSAGE APP LIST", "Lists the four message bridges included with GSV and what each one needs.", "Discord, Slack, Telegram, and WhatsApp describe themselves once; other bridges can still follow the same service instructions.", "The bundled list drives building, setup, and checks."],
      "release-bundles": ["READY-TO-RUN COPIES", "Builds a separate copy for GSV's front door, file history, and every bundled message bridge.", "Each copy receives a check number so its exact contents can be confirmed.", "One message bridge cannot silently become part of another."],
      "development-stacks": ["PRACTICE SETUP", "Starts the pieces together on a developer's computer for testing.", "It copies the important online connections.", "It is for practice, not a shortcut around the safety rules of a real GSV."],
    },
  },
};

const EDGE_COPY = {
  "deployment-services": "provides reusable connections for hosted services",
  "deployment-gateway": "puts the front door online",
  "deployment-adapters": "builds the bundled message bridges",
  "deployment-ripgit": "puts file history online",
  "services-gateway": "confirms the right GSV home and its status",
  "services-inference": "sets the rules for optional hosted AI",
  "services-adapters": "sets the rules for message bridges and managed email",
  "sdk-protocol": "follows the shared rules",
  "sdk-gateway": "connects apps to the front door",
  "web-sdk": "uses the ready-made app connection",
  "extension-sdk": "uses the ready-made app connection",
  "host-protocol": "follows the shared rules",
  "protocol-gateway": "uses the agreed message labels",
  "gateway-kernel": "hands an approved home to the controller",
  "web-gateway": "carries a signed-in person's visit",
  "host-gateway-human": "carries desktop and text-control visits",
  "host-gateway-machine": "connects the computer tool runner",
  "adapters-gateway": "carries messages through a limited service door",
  "extension-gateway": "connects the browser work place",
  "kernel-process": "starts, stops, and updates an agent",
  "process-inference": "asks the chosen AI for one answer",
  "process-kernel": "asks for approved work and sends visible messages",
  "kernel-conversation": "adds approved messages to shared history",
  "kernel-native": "sends work to GSV's built-in workshop",
  "kernel-host": "sends approved work to your computer",
  "kernel-extension": "sends approved work to your browser",
  "kernel-adapters": "sends replies through message bridges",
  "kernel-ripgit": "changes a saved project",
  "native-ripgit": "opens folders that remember every change",
};

const FLOW_COPY = {
  "human-turn": {
    label: "WHAT HAPPENS WHEN YOU SEND A MESSAGE",
    summary: "Follow one message from your screen to the agent and back into the shared history.",
    route: ["web/chat", "host/desktop", "gateway/edge-router", "kernel/identity-policy", "conversation/conversation-do", "process/agent-loop", "inference/inference-service", "process/tools-approvals", "kernel/delivery-coordination", "conversation/message-store"],
    steps: [
      ["You send a message on the website", "The signed-in website sends your words to your GSV home."],
      ["Or you use the desktop app", "The desktop app can send the same message directly. Message apps use their own story."],
      ["The right GSV home is found", "The front door checks the web address before touching anything private."],
      ["GSV checks who you are and what you may do", "The traffic controller works out who you are and whether you may use this conversation and agent."],
      ["Your message is saved", "The exact message is added to the shared history before the agent starts."],
      ["The agent starts working", "The working agent reads its instructions, your message, and the information it needs."],
      ["The AI answers", "The AI connection carries one live answer and can stop it if the work is cancelled."],
      ["The agent sends a visible reply", "A reply becomes visible when the agent deliberately sends it; the agent may keep working afterward."],
      ["Open screens are updated", "The live screen gets the update, and every other signed-in screen learns that a message was saved."],
      ["The reply stays in history", "The shared message remains even if the working agent is later cleared or replaced."],
    ],
  },
  "target-syscall": {
    label: "HOW A TOOL RUNS IN THE RIGHT PLACE",
    summary: "Follow one file, typed instruction, or website action from the agent to GSV, your computer, or your browser.",
    route: ["process/tools-approvals", "kernel/dispatch-routing", "native-target/target-provider", "host/machine", "extension/supervisor-driver", "kernel/dispatch-routing", "process/process-store"],
    steps: [
      ["The agent asks to use a tool", "The request says what to do and where it should happen."],
      ["Permission and location are checked", "The traffic controller checks the exact action, the chosen place, and whether that place is ready."],
      ["GSV can do it", "The built-in workshop handles GSV files, one short typed instruction, or a website request."],
      ["Your computer can do it", "The computer tool runner is responsible for the job, its answer, stopping, and cleanup."],
      ["Your browser can do it", "The browser helper owns approved work with browser files, tabs, or pages."],
      ["One final result comes back", "The temporary path closes when the result arrives, the work is cancelled, the connection drops, or time runs out."],
      ["The agent saves the result", "The working agent records the finished result before deciding what to do next."],
    ],
  },
  "adapter-ingress": {
    label: "HOW A MESSAGE APP GETS A REPLY",
    summary: "Follow a message from Discord, Telegram, Slack, or WhatsApp into GSV and safely back out.",
    route: ["adapters/shared", "gateway/service-entrypoints", "kernel/delivery-coordination", "conversation/conversation-do", "process/agent-loop", "kernel/delivery-coordination", "adapters/shared"],
    steps: [
      ["The outside message is recorded", "The message bridge saves the complete incoming message and a record that it was received before it asks GSV to act."],
      ["The bridge uses its locked door", "The setup fixes which bridge this is and the few actions it may ask for."],
      ["The sender and conversation are found", "The traffic controller checks the saved link and chooses the right person, conversation, and agent."],
      ["The incoming message is saved", "The message is changed into GSV's shared format, then it and its lasting files enter shared history once."],
      ["The agent works", "The working agent handles it the same way it handles a message from the website or desktop app."],
      ["Only a sent reply leaves GSV", "Private drafts and reasoning never travel to the message app."],
      ["Delivery is recorded", "The bridge sends the reply once, tries again only when that cannot create a duplicate, and remembers unclear results instead of guessing."],
    ],
  },
  "managed-routing": {
    label: "HOW A VISIT REACHES THE RIGHT GSV",
    summary: "See how a public web address becomes one private GSV home before ordinary work can begin.",
    route: ["services/directory", "gateway/installation-routing", "gateway/installation-storage", "kernel/kernel-do", "process/agent-loop", "kernel/kernel-do"],
    steps: [
      ["Look up the web address", "A trusted address book returns the matching private GSV home and whether it is active."],
      ["Stop unknown or inactive visits", "Only a known, active home may receive ordinary work."],
      ["Keep all saved information together", "Every saved place uses the same private home number."],
      ["Open the home's main controller", "That private number reaches the one traffic controller for this GSV home."],
      ["Check again before paused work resumes", "An agent that wakes later makes sure the home is active before continuing."],
      ["Check again before background work", "Schedules and other unattended work make the same safety check."],
    ],
  },
  "versioned-files": {
    label: "HOW GSV SAVES FILES WITH HISTORY",
    summary: "Follow a file change into ordinary saving or into a project that remembers every version.",
    route: ["web/work-surfaces", "kernel/identity-policy", "native-target/gsv-fs", "kernel/dispatch-routing", "ripgit/hyperspace", "web/work-surfaces"],
    steps: [
      ["Choose the kind of file change", "A person, app, or agent asks to change a normal file or a project that remembers its changes."],
      ["Check the owner and permission", "The traffic controller checks the person, account, project, and requested kind of change."],
      ["Normal file tools choose the right saved place", "Home and source folders can use file history, while ordinary work folders use simpler saving."],
      ["Project changes take a direct path", "A deliberate project-history action goes straight to the correct private project."],
      ["The whole change is saved together", "Readers see either the old version or the new version, never a half-finished mixture."],
      ["The screen reads the saved version", "The app learns that something changed and reloads the latest saved version."],
    ],
  },
  "native-client": {
    label: "HOW THE DESKTOP APP AND YOUR COMPUTER WORK TOGETHER",
    summary: "See why chat, computer tools, text controls, and voice helpers stay separate even on one computer.",
    route: ["host/desktop", "gateway/edge-router", "host/machine", "host/host-contracts", "host/helpers"],
    steps: [
      ["The desktop app owns the visible work", "It keeps the chosen agent, conversation view, drafts, approvals, attachments, and temporary screen choices."],
      ["Chat goes straight to GSV", "The desktop app talks to the front door as the signed-in person. It does not need the computer tool runner for chat."],
      ["Computer tools use a separate runner", "That runner performs only the approved actions on this computer that it says it can do."],
      ["Computer controls stay narrow", "The desktop app and text controls can check or change GSV programs on the same computer without becoming a hidden work path."],
      ["Voice and gestures stay private", "Raw microphone and camera information stays on the computer; only finished text or a simple action leaves the helper."],
    ],
  },
  "deployment-assembly": {
    label: "HOW GSV IS PUT TOGETHER",
    summary: "Follow a setup plan as it becomes separate, connected online programs.",
    route: ["deployment/runtime-manifest", "deployment/adapter-catalog", "deployment/release-bundles", "deployment/runtime-composition", "ripgit/worker-repository-do", "gateway/service-entrypoints"],
    steps: [
      ["Read the setup plan", "The setup chooses matching program pieces for the front door, website, file history, and message bridges."],
      ["Read the message-app list", "Each supported message app describes what it needs in one shared list."],
      ["Build each piece separately", "The front door, file history, and every bundled bridge receive their own checked copy."],
      ["Connect saved places and private doors", "The setup creates the web addresses, saved places, and named connections between the pieces."],
      ["Start file history", "Project history remains a separate online service that owns its own saved projects."],
      ["Lock each message bridge to its name", "The setup decides which bridge is connected and what it may ask for. Setup does not grant user permission."],
    ],
  },
};

function systemCopy(id) {
  const copy = SYSTEM_COPY[id];
  if (!copy) throw new Error(`Missing plain-language system copy: ${id}`);
  return copy;
}

function componentCopy(systemId, componentId) {
  const copy = systemCopy(systemId).components[componentId];
  if (!copy) throw new Error(`Missing plain-language component copy: ${systemId}/${componentId}`);
  const [plainLabel, summary, ...mechanics] = copy;
  return { plainLabel, summary, mechanics };
}

export const PLAIN_SUBSYSTEMS = ARCHITECTURE_SUBSYSTEMS.map((system) => {
  const copy = systemCopy(system.id);
  return {
    ...system,
    plainLabel: copy.plainLabel,
    summary: copy.summary,
    owns: copy.owns,
    boundary: copy.boundary,
    invariant: copy.invariant,
    components: system.components.map((component) => ({
      ...component,
      ...componentCopy(system.id, component.id),
    })),
  };
});

export const PLAIN_EDGES = ARCHITECTURE_EDGES.map((edge) => {
  const label = EDGE_COPY[edge.id];
  if (!label) throw new Error(`Missing plain-language connection copy: ${edge.id}`);
  return { ...edge, label };
});

export const PLAIN_FLOWS = ARCHITECTURE_FLOWS.map((flow) => {
  const copy = FLOW_COPY[flow.id];
  if (!copy) throw new Error(`Missing plain-language story copy: ${flow.id}`);
  if (copy.steps.length !== flow.steps.length) {
    throw new Error(`Plain-language story length changed: ${flow.id}`);
  }
  const route = flow.steps.map(({ subsystemId, componentId }) => componentId ? `${subsystemId}/${componentId}` : subsystemId);
  if (route.some((step, index) => step !== copy.route[index])) {
    throw new Error(`Plain-language story route changed: ${flow.id}`);
  }
  return {
    ...flow,
    label: copy.label,
    summary: copy.summary,
    steps: flow.steps.map((step, index) => {
      const [label, detail] = copy.steps[index];
      return { ...step, label, detail };
    }),
  };
});

const systemById = new Map(PLAIN_SUBSYSTEMS.map((system) => [system.id, system]));

export function plainSubsystem(id) {
  const system = systemById.get(id);
  if (!system) throw new Error(`Unknown GSV place: ${id}`);
  return system;
}

export function plainComponent(systemId, componentId) {
  if (!componentId) return null;
  return plainSubsystem(systemId).components.find((component) => component.id === componentId) ?? null;
}

export function searchPlainLanguage(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const results = [];
  for (const system of PLAIN_SUBSYSTEMS) {
    const systemText = [system.label, system.shortLabel, system.plainLabel, system.summary, system.boundary, system.invariant, system.sourceRoot, ...system.owns].join(" ").toLowerCase();
    if (terms.every((term) => systemText.includes(term))) {
      results.push({
        subsystemId: system.id,
        label: system.label,
        path: system.sourceRoot,
        summary: system.summary,
        score: searchScore(system.label, system.sourceRoot, terms),
      });
    }
    for (const component of system.components) {
      const componentText = [component.label, component.plainLabel, component.summary, ...component.mechanics, ...component.paths].join(" ").toLowerCase();
      if (!terms.every((term) => componentText.includes(term))) continue;
      results.push({
        subsystemId: system.id,
        componentId: component.id,
        label: component.label,
        path: component.paths[0],
        summary: component.summary,
        score: searchScore(component.label, component.paths[0], terms),
      });
    }
  }
  return results.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label)).slice(0, 18);
}

function searchScore(label, path, terms) {
  const normalizedLabel = label.toLowerCase();
  return terms.reduce((score, term) => {
    if (normalizedLabel === term) return score + 12;
    if (normalizedLabel.startsWith(term)) return score + 8;
    if (normalizedLabel.includes(term)) return score + 5;
    if (path.toLowerCase().includes(term)) return score + 3;
    return score + 1;
  }, 0);
}

export const PLAIN_LANGUAGE_COPY = {
  systems: SYSTEM_COPY,
  edges: EDGE_COPY,
  flows: FLOW_COPY,
};
