export const ATLAS_SCHEMA_VERSION = 2;

export const ATLAS_DISTRICTS = [
  {
    id: "gateway-gate",
    label: "FRONT DOOR",
    shortLabel: "ENTRY",
    summary: "Every visit stops here first so GSV can find the right private home.",
    zone: "boundary",
    systems: ["gateway"],
    layout: { kind: "singleton", center: { x: 0, z: -164 }, spacing: 0 },
  },
  {
    id: "control-core",
    label: "MAIN GSV",
    shortLabel: "MAIN",
    summary: "The rule keeper, working agent, and shared messages live close together but keep separate jobs.",
    zone: "installation",
    systems: ["kernel", "process", "conversation"],
    layout: { kind: "triangle", center: { x: 0, z: 0 }, spacing: 111 },
  },
  {
    id: "installation-works",
    label: "BUILT-IN WORK AREA",
    shortLabel: "WORK AREA",
    summary: "GSV's own files, simple tools, and file history live here.",
    zone: "installation",
    systems: ["native-target", "ripgit"],
    layout: { kind: "row-x", center: { x: 0, z: 80 }, spacing: 110 },
  },
  {
    id: "contract-causeway",
    label: "SHARED RULES",
    shortLabel: "RULES",
    summary: "Common instructions let different GSV parts understand each other without giving anyone permission.",
    zone: "bridge",
    systems: ["protocol", "sdk"],
    layout: { kind: "row-x", center: { x: -171, z: -68 }, spacing: 78, reverse: true },
  },
  {
    id: "human-ports",
    label: "WEBSITE",
    shortLabel: "WEB",
    summary: "This is the browser screen people see and use.",
    zone: "outer",
    systems: ["web"],
    layout: { kind: "singleton", center: { x: -190, z: 5 }, spacing: 0 },
  },
  {
    id: "native-campus",
    label: "YOUR COMPUTER",
    shortLabel: "COMPUTER",
    summary: "The desktop app, computer tool runner, text controls, and private helpers live here as separate programs.",
    zone: "outer",
    systems: ["host"],
    layout: { kind: "singleton", center: { x: -190, z: 79 }, spacing: 0 },
  },
  {
    id: "exchange-docks",
    label: "OUTSIDE SERVICES",
    shortLabel: "SERVICES",
    summary: "Optional account help, AI services, and messaging apps connect here through limited doors.",
    zone: "outer",
    systems: ["services", "inference", "adapters"],
    layout: {
      kind: "row-z",
      center: { x: 190, z: -5 },
      spacing: 72,
      offsets: { inference: { x: -26, z: 0 } },
    },
  },
  {
    id: "target-frontier",
    label: "BROWSER WORK AREA",
    shortLabel: "BROWSER",
    summary: "An approved agent can work with browser tabs and pages here.",
    zone: "outer",
    systems: ["extension"],
    layout: { kind: "singleton", center: { x: 170, z: 132 }, spacing: 0 },
  },
  {
    id: "provisioning-yard",
    label: "SETUP AREA",
    shortLabel: "SETUP",
    summary: "The pieces are built and connected here before GSV starts running.",
    zone: "outer",
    systems: ["deployment"],
    layout: { kind: "singleton", center: { x: 82, z: -224 }, spacing: 0 },
  },
];

export const ATLAS_ARCHETYPES = {
  portal: {
    label: "TWIN ENTRY",
    summary: "Two bright towers mark the one place every visit must pass first.",
    width: 54,
    depth: 24,
    height: 36,
    crownHeight: 14,
  },
  citadel: {
    label: "TALL CONTROL TOWER",
    summary: "A tall center and guarded sides show the one place that checks rules and directs work.",
    width: 44,
    depth: 42,
    height: 72,
    crownHeight: 18,
  },
  "process-pods": {
    label: "WORK PODS",
    summary: "Separate pods show that each agent keeps its own private work.",
    width: 48,
    depth: 40,
    height: 54,
    crownHeight: 12,
  },
  archive: {
    label: "MESSAGE STACK",
    summary: "Stepped layers show recent messages above older saved messages.",
    width: 48,
    depth: 40,
    height: 48,
    crownHeight: 14,
  },
  "contract-lattice": {
    label: "OPEN RULE GRID",
    summary: "An open grid shows shared rules rather than a place that runs work.",
    width: 54,
    depth: 22,
    height: 18,
    crownHeight: 20,
  },
  "contract-hall": {
    label: "SHARED INSTRUCTION BLOCK",
    summary: "A low block shows ready-made instructions that make app building easier.",
    width: 48,
    depth: 30,
    height: 34,
    crownHeight: 12,
  },
  workshop: {
    label: "TOOL WORKSHOP",
    summary: "Tall tool fins show a place where approved work can really happen.",
    width: 48,
    depth: 38,
    height: 38,
    crownHeight: 14,
  },
  exchange: {
    label: "SERVICE TOWER",
    summary: "A bright signal mast shows information moving to or from an outside service.",
    width: 42,
    depth: 36,
    height: 50,
    crownHeight: 24,
  },
  terminal: {
    label: "PEOPLE'S SCREEN",
    summary: "A wide display marks a place made for people to use.",
    width: 44,
    depth: 30,
    height: 38,
    crownHeight: 12,
  },
  campus: {
    label: "COMPUTER GROUP",
    summary: "Several connected blocks show separate programs that live on one computer.",
    width: 54,
    depth: 42,
    height: 38,
    crownHeight: 14,
  },
  vault: {
    label: "HISTORY VAULT",
    summary: "Repeated cells show separate projects with their own saved file history.",
    width: 48,
    depth: 44,
    height: 46,
    crownHeight: 18,
  },
  yard: {
    label: "SETUP PLATFORM",
    summary: "A low platform shows pieces being put together before they begin running.",
    width: 56,
    depth: 38,
    height: 28,
    crownHeight: 22,
  },
};

export const ATLAS_LENSES = [
  {
    id: "runtime",
    label: "HOW WORK MOVES",
    shortLabel: "WORK",
    summary: "See what is happening and where the next step goes.",
  },
  {
    id: "ownership",
    label: "WHO HANDLES IT",
    shortLabel: "WHO",
    summary: "See which place is responsible for each job and where that job stops.",
  },
  {
    id: "security",
    label: "WHAT KEEPS IT SAFE",
    shortLabel: "SAFETY",
    summary: "See where GSV checks who is asking and what they may do before work begins.",
  },
  {
    id: "durability",
    label: "WHAT IT REMEMBERS",
    shortLabel: "MEMORY",
    summary: "See which places keep information after a screen closes or a program restarts.",
  },
];

export const ATLAS_ZONES = [
  {
    id: "installation",
    label: "PRIVATE GSV HOME",
    summary: "The private center that belongs to one GSV home.",
    radius: 144,
  },
  {
    id: "boundary",
    label: "ENTRY CHECK",
    summary: "The line every visit crosses before reaching private information.",
    radius: 164,
  },
  {
    id: "outer",
    label: "OUTSIDE CONNECTIONS",
    summary: "Apps and services outside the private home do not gain permission just by connecting.",
    radius: 270,
  },
];

export const ATLAS_CONCEPTS = [
  "A web address is not the private GSV home behind it.",
  "A connection is not permission.",
  "Being able to do a job does not mean being allowed to do it.",
  "A live screen update is not the saved conversation.",
  "An agent's private work is not the message history people see.",
  "A message bridge and a place where tools run are different jobs.",
  "Setup connects the pieces; it does not grant user permission.",
];

export const ATLAS_SYSTEM_DETAIL = {
  gateway: {
    archetype: "portal",
    gate: "ADDRESS CHECK",
    scope: "the public front door",
    runtime: "A small online front-door service",
    owner: "Finding the right GSV home before anything private is opened",
    persistence: "It does not keep the private home's lasting records. It uses the trusted address book to send each visit onward.",
    admission: "It checks the web address in a trusted address book and continues only when the matching GSV home is active.",
    completion: "It either hands the visit to the right place or stops it and closes anything left unfinished.",
    security: [
      "A made-up web address cannot create or open a private GSV home.",
      "A visitor never supplies the private home number.",
      "Older one-home setups keep that home clearly named instead of trusting every address.",
    ],
    docs: ["docs/architecture/security-model.md", "docs/architecture/services.md"],
    tests: [
      "gateway/test-integration/managed-routing.test.ts",
      "gateway/src/installation/routing.test.ts",
      "gateway/src/installation/lifecycle.test.ts",
    ],
  },
  kernel: {
    archetype: "citadel",
    foundation: "SAVED RULES",
    gate: "PERMISSION CHECK",
    scope: "the private rule center",
    runtime: "One careful coordinator for each GSV home",
    owner: "Checking who is asking and what they may do, then directing approved work",
    persistence: "It keeps people, permissions, settings, schedules, connections, and unfinished promises.",
    admission: "It works out who is asking, checks what that person may do, and checks that the exact item belongs to them.",
    completion: "It follows each handoff until it finishes, fails, times out, disconnects, or is cancelled.",
    security: [
      "Being connected and claiming a name never gives permission.",
      "Important actions are checked here even when a screen already hid the button.",
      "It directs work to GSV, a computer, or a browser; it does not do all that work itself.",
    ],
    docs: [
      "docs/architecture/unified-protocol-peers.md",
      "docs/architecture/security-model.md",
      "docs/reference/routing.md",
    ],
    tests: [
      "gateway/src/kernel/dispatch.test.ts",
      "gateway/src/kernel/routing.test.ts",
      "gateway/src/kernel/capabilities.test.ts",
      "gateway/src/kernel/run-routes.test.ts",
    ],
  },
  process: {
    archetype: "process-pods",
    foundation: "PRIVATE WORK + FILES",
    gate: "BLOCK LATE WORK",
    scope: "one agent's private work area",
    runtime: "One restart-safe working agent",
    owner: "The agent's private work, waiting messages, tool results, and stop controls",
    persistence: "It keeps private work, waiting input, unfinished tools, approvals, starting instructions, and attachments.",
    admission: "The traffic controller sends in work only after checking who asked and what they may do.",
    completion: "It ignores late results, finishes or cancels unfinished tools, and keeps stopping, clearing, and ending as separate choices.",
    security: [
      "An agent can use only the permission it was given and cannot give itself more.",
      "A fully ended agent never quietly comes back, and its number is not given to a replacement.",
      "Instructions guide the agent; they do not replace the real permission checks.",
    ],
    docs: [
      "docs/architecture/agent-loop.md",
      "docs/architecture/process-ipc-and-scheduler.md",
      "docs/architecture/responsibilities-and-context-epochs.md",
    ],
    tests: [
      "gateway/src/process/do.test.ts",
      "gateway/src/process/store.test.ts",
      "gateway/test-integration/process-controls.test.ts",
    ],
  },
  conversation: {
    archetype: "archive",
    foundation: "SAVED MESSAGES",
    gate: "ADD ONLY",
    scope: "the shared message book",
    runtime: "One ordered message book for each conversation",
    owner: "The messages people can see and lasting links to their files",
    persistence: "Recent messages stay close for quick reading; older groups and shared files move to a lasting saved place.",
    admission: "Only the traffic controller may add a message, and every addition names the conversation and sender.",
    completion: "Each visible message is saved once; other parts separately update screens and deliver replies to messaging apps.",
    security: [
      "Shared messages are separate from the agent's private work.",
      "A live screen update does not own or replace the saved conversation.",
      "Messaging apps receive sent replies, never private reasoning or drafts.",
    ],
    docs: ["docs/architecture/conversations.md", "docs/architecture/resource-references.md"],
    tests: [
      "gateway/src/conversation/do.test.ts",
      "gateway/src/kernel/conversation-handlers.test.ts",
      "gateway/src/kernel/run-routes.test.ts",
    ],
  },
  protocol: {
    archetype: "contract-lattice",
    scope: "the shared instruction book",
    runtime: "A common set of message and action rules",
    owner: "The required information and meaning of requests, replies, updates, and large file moves",
    persistence: "It keeps no private information. It only describes how information should move.",
    admission: "Incoming messages are checked to make sure the required information is present and valid, but the receiver still checks who sent them and what that person may do.",
    completion: "Every request or file move ends clearly: completed, failed, cancelled, or passed to a named next part.",
    security: [
      "A message containing all the right information does not prove permission.",
      "Who sent it, what they may do, which updates are allowed, and where it came from are checked separately.",
      "Large files travel separately, with one part clearly responsible until the move ends.",
    ],
    docs: ["docs/reference/syscalls.md", "docs/reference/websocket-protocol.md", "docs/reference/routing.md"],
    tests: [
      "gateway/src/protocol/decode-wire-frame.test.ts",
      "gateway/src/protocol/process-run-stream.test.ts",
      "packages/gsv/test/client-body.test.mjs",
    ],
  },
  "native-target": {
    archetype: "workshop",
    scope: "GSV's built-in work place",
    runtime: "A built-in helper for files, one typed instruction, and websites",
    owner: "GSV files and folders, one short typed instruction, and approved website requests",
    persistence: "It joins system information, agent files, ordinary stored files, and folders that remember every change into one view.",
    admission: "The traffic controller checks permission and sends only actions this built-in work place honestly supports.",
    completion: "It is responsible for each typed instruction, file move, temporary item, and stop request until one final result returns.",
    security: [
      "Choosing where work happens does not change what the action means.",
      "It offers familiar files and simple instructions, not every kind of work a full computer can do.",
      "People and apps do not need to know which saved place sits behind each folder.",
    ],
    docs: ["docs/architecture/targets.md", "docs/architecture/context-and-knowledge.md"],
    tests: ["gateway/src/drivers/native/shell.test.ts", "gateway/src/fs/fs.test.ts"],
  },
  inference: {
    archetype: "exchange",
    scope: "the doorway to an AI service",
    runtime: "A live connection to the chosen AI service",
    owner: "Choosing an allowed kind of AI and carrying one text, speech, or picture request",
    persistence: "Shared choices are saved by GSV and agent-specific choices are saved with that agent. A live AI answer is not stored here.",
    admission: "The traffic controller chooses an allowed kind of AI and shows the agent only features it may use.",
    completion: "It finishes or stops the live AI answer and returns one clear final result to the working agent.",
    security: [
      "Being able to reach an AI company does not mean an agent is allowed to use it.",
      "The AI company receives only the information deliberately sent for that request.",
      "Optional paid AI access remains a separate service chosen by the GSV owner.",
    ],
    docs: ["docs/architecture/agent-loop.md", "docs/architecture/services.md"],
    tests: ["gateway/src/inference/service.test.ts", "gateway/src/inference/model-registry.test.ts"],
  },
  sdk: {
    archetype: "contract-hall",
    scope: "the app maker's helper kit",
    runtime: "A ready-made connection used by GSV apps",
    owner: "Sending requests, receiving updates, stopping work, handling time limits, and moving large files",
    persistence: "It keeps only the live work for its current connection. It is not the official keeper of GSV information.",
    admission: "An app signs in through its connection; the helper's convenient buttons never skip the traffic controller's checks.",
    completion: "It finishes every waiting request when a reply arrives, time runs out, work is stopped, or the connection closes.",
    security: [
      "A convenient app helper does not become the rule keeper.",
      "Saying what an app can do does not say who may ask it to do that.",
      "Apps and GSV use the same shared message rules instead of inventing competing versions.",
    ],
    docs: ["docs/architecture/unified-protocol-peers.md", "docs/reference/websocket-protocol.md"],
    tests: ["packages/gsv/test/client-body.test.mjs", "packages/gsv/test/adapter-protocol.test.mjs"],
  },
  services: {
    archetype: "contract-hall",
    scope: "optional account help",
    runtime: "Shared instructions used by the company running GSV or by someone running GSV themselves",
    owner: "Instructions for the GSV address book, first setup, available options, hosted AI, email, and message bridges",
    persistence: "Each real service keeps its own records. These shared instructions do not form one giant running service.",
    admission: "Private service connections and one-time setup keys limit access; public visitors cannot choose a private GSV home.",
    completion: "Each real service is clearly responsible for taking work, trying again without causing duplicates, finishing, and explaining problems.",
    security: [
      "Account and paid-AI help stays with the company running it; message bridges you run yourself stay separate.",
      "Only an active GSV home may receive ordinary work.",
      "A first-time setup key opens one new home once; it is not a key that opens everything.",
    ],
    docs: ["docs/architecture/services.md", "docs/architecture/security-model.md"],
    tests: ["gateway/test-integration/managed-routing.test.ts", "packages/gsv/test/managed-inference-stream.test.mjs"],
  },
  web: {
    archetype: "terminal",
    scope: "the browser screen people use",
    runtime: "A website running in the browser",
    owner: "What people see, first setup, sign-in, drafts, screen controls, and keeping the browser up to date",
    persistence: "It keeps only temporary screen and sign-in information. The private GSV home keeps the lasting information.",
    admission: "The browser signs in and receives only the screens and actions that person may use.",
    completion: "Each screen owns the work it starts and stopping it; after a saved change, it reloads the trusted result.",
    security: [
      "A hidden or disabled button is helpful feedback, not the real permission check.",
      "Opening a separate agent's work does not replace the person's main conversation elsewhere.",
      "This website uses GSV; it is not where GSV's central rules live.",
    ],
    docs: ["docs/architecture/conversations.md", "engineering/builtin-app-design.md"],
    tests: ["web/src/app/services/gateway/frameBody.test.ts", "web/src/app/services/session/sessionService.test.ts"],
  },
  host: {
    archetype: "campus",
    foundation: "COMPUTER SETTINGS",
    scope: "the GSV programs on a computer",
    runtime: "Separate desktop, text-control, tool-runner, voice, and gesture programs",
    owner: "The computer screen, controls on that computer, approved computer work, and private voice or gesture help",
    persistence: "It keeps locked computer settings, desktop screen choices, unfinished file moves, and helper files on the computer.",
    admission: "The desktop and text controls sign in as the person; the tool runner signs in as the computer; controls on the computer stay limited to that computer's user.",
    completion: "Each program is responsible for the jobs, reconnecting, computer messages, file moves, and shutdown that it started.",
    security: [
      "The desktop app and computer tool runner are separate; chat does not secretly pass through the runner.",
      "A computer is one possible place to do work, not the only kind of work place.",
      "Raw microphone and camera information stays inside the small helpers on the computer.",
    ],
    docs: ["docs/architecture/rust-host-applications.md", "docs/architecture/targets.md"],
    tests: ["host/apps/machine/tests/tools_test.rs", "host/crates/desktop-protocol/tests/unix_end_to_end.rs"],
  },
  adapters: {
    archetype: "exchange",
    foundation: "DELIVERY RECORDS",
    gate: "KNOWN BRIDGE + CONFIRMED PERSON",
    scope: "bridges to outside message apps",
    runtime: "A separate bridge for each messaging app",
    owner: "Outside account sign-in, preparing messages, trying again without causing duplicates, and delivery records",
    persistence: "Each bridge keeps records of what was received, outside account details, whether it is connected, and delivery results. Shared bridges also keep confirmed person links where needed.",
    admission: "The setup fixes each bridge's name and limits; shared bridges link a person only after signed-in confirmation.",
    completion: "An incoming message is saved before it causes work; an outgoing message ends as sent, safe to retry, failed, or uncertain.",
    security: [
      "A public message or pairing code never chooses a private GSV home or person inside it.",
      "An outside account name does not grant normal GSV permission.",
      "Carrying messages and offering a place for tools to work are separate jobs.",
      "Signed-in confirmation and old-link protection apply to shared bridges run for many people, not every bridge you run yourself or use for practice.",
    ],
    docs: ["docs/architecture/adapter-model.md", "docs/architecture/interaction-surface-bindings.md"],
    tests: ["adapters/shared/test/inbound-delivery.test.ts", "adapters/shared/test/delivery-ledger.test.ts"],
  },
  extension: {
    archetype: "workshop",
    foundation: "SAVED IN BROWSER",
    gate: "BROWSER + GSV",
    scope: "an approved browser work place",
    runtime: "A browser add-on with small background helpers",
    owner: "One browser's tabs, pages, saved working files, recordings, and approved actions",
    persistence: "It keeps a private browser work folder plus connection and recording state inside that browser.",
    admission: "It receives only actions it says it can do and that both GSV and the browser have allowed.",
    completion: "It is responsible for reconnecting, stopping old work, browser actions, recordings, file moves, and cleanup.",
    security: [
      "The browser helper is not the GSV website and not a message bridge.",
      "Its list of available actions says what it can do, not who may ask.",
      "Power over the browser stays visible and requires a separate permission check.",
    ],
    docs: ["docs/architecture/targets.md", "docs/architecture/unified-protocol-peers.md"],
    tests: ["extension/src/background/connection-supervisor.test.ts", "extension/src/target/shell.test.ts"],
  },
  ripgit: {
    archetype: "vault",
    foundation: "PROJECT HISTORY",
    gate: "OWNER CHECK",
    scope: "file history that remembers every change",
    runtime: "One careful history keeper for each project",
    owner: "Project versions, alternate lines of work, file changes, search, comparison, and all-at-once updates",
    persistence: "Each private GSV home keeps real project history and the file pieces needed to rebuild every saved version.",
    admission: "The front door checks the person or app, replaces any claimed home number with the trusted one, and opens the correct project.",
    completion: "A project change finishes only after every file piece is handled and the whole new version is saved together.",
    security: [
      "A project name belongs to one private GSV home.",
      "A public project-history address never chooses the private home behind it.",
      "Older one-home setups keep their naming rule clear and explicit.",
    ],
    docs: ["docs/reference/r2-storage.md", "docs/architecture/context-and-knowledge.md"],
    tests: ["ripgit/tests/installation-isolation.spec.mjs", "gateway/src/installation/ripgit.test.ts"],
  },
  deployment: {
    archetype: "yard",
    foundation: "SETUP FILES",
    scope: "the build and setup area",
    runtime: "Tools for making a GSV version and a saved setup program for running GSV yourself",
    owner: "Setup lists, matching program pieces, web addresses, saved information, and private connections",
    persistence: "It keeps the chosen GSV version and message-app lists plus check numbers for the copies it builds.",
    admission: "Only the person running setup and the checked GSV version lists may build the system; setup choices never become user permission.",
    completion: "Setup finishes only after every separate piece is built, connected, and recorded as one matching GSV version.",
    security: [
      "Setup chooses the connections; every running piece still checks who is asking and what they may do.",
      "The setup fixes each message bridge's name and limits instead of trusting incoming messages.",
      "GSV includes reusable setup pieces; a company running it keeps its full setup in its own project.",
    ],
    docs: ["docs/how-to/deploy-with-alchemy.md", "docs/reference/cli-commands.md"],
    tests: ["deployment/test/manifest.test.ts", "scripts/check-managed-deployment.sh"],
  },
};

export const ATLAS_TOUR_NOTES = {
  "human-turn": {
    thesis: "The agent's private work and the shared conversation are linked, but they are never the same thing.",
    warning: "Live screen updates may come and go. Messaging apps receive only replies that were truly sent.",
  },
  "target-syscall": {
    thesis: "The same file, typed instruction, or web action keeps the same meaning wherever it runs.",
    warning: "A connected place may say what it can do, but GSV still decides who may ask.",
  },
  "adapter-ingress": {
    thesis: "Message bridges prepare and safely deliver outside messages while GSV still checks who is asking and what they may do.",
    warning: "An outside message never jumps straight into an agent, and private agent work never goes back to the message app.",
  },
  "managed-routing": {
    thesis: "GSV finds the private home from a trusted address book before it opens anything inside.",
    warning: "The public name helps find the home; it is not the home's private number.",
  },
  "versioned-files": {
    thesis: "One familiar file view hides several saved places, while deliberate project-history changes take their own path.",
    warning: "Ordinary work folders use simple saving today; only selected home, source, and project areas keep change history.",
  },
  "native-client": {
    thesis: "The desktop app, text controls, computer tool runner, and private helpers are separate programs with small jobs.",
    warning: "Chat does not secretly pass through the computer tool runner, and the helpers are not alternate doors into GSV.",
  },
  "deployment-assembly": {
    thesis: "The setup for running GSV yourself turns a checked version list into separate online pieces with clearly named connections.",
    warning: "Setup connects the system but does not grant user permission, and updating the online front door does not update computer or browser apps.",
  },
};

const DISTRICT_BY_SYSTEM = new Map();
for (const district of ATLAS_DISTRICTS) {
  for (const systemId of district.systems) {
    if (DISTRICT_BY_SYSTEM.has(systemId)) {
      throw new Error(`Subsystem belongs to more than one atlas district: ${systemId}`);
    }
    DISTRICT_BY_SYSTEM.set(systemId, district);
  }
}

export function atlasDistrict(id) {
  const district = ATLAS_DISTRICTS.find((candidate) => candidate.id === id);
  if (!district) {
    throw new Error(`Missing atlas district: ${id}`);
  }
  return district;
}

export function atlasDistrictForSystem(systemId) {
  const district = DISTRICT_BY_SYSTEM.get(systemId);
  if (!district) {
    throw new Error(`Subsystem is not assigned to an atlas district: ${systemId}`);
  }
  return district;
}

export function atlasArchetype(id) {
  const archetype = ATLAS_ARCHETYPES[id];
  if (!archetype) {
    throw new Error(`Missing atlas archetype: ${id}`);
  }
  return archetype;
}

export function atlasScene(subsystem) {
  const detail = atlasDetail(subsystem.id);
  const district = atlasDistrictForSystem(subsystem.id);
  const archetype = atlasArchetype(detail.archetype);
  const index = district.systems.indexOf(subsystem.id);
  const { center, kind, offsets = {}, reverse = false, spacing } = district.layout;
  const direction = reverse ? -1 : 1;
  let x = center.x;
  let z = center.z;

  if (kind === "row-x") {
    x += (index - (district.systems.length - 1) / 2) * spacing * direction;
  } else if (kind === "row-z") {
    z += (index - (district.systems.length - 1) / 2) * spacing * direction;
  } else if (kind === "triangle") {
    const offsets = [
      { x: 0, z: -spacing * 0.5 },
      { x: -spacing * 0.65, z: 0 },
      { x: spacing * 0.65, z: 0 },
    ];
    const offset = offsets[index];
    if (!offset) throw new Error(`Triangle district has too many systems: ${district.id}`);
    x += offset.x;
    z += offset.z;
  } else if (kind !== "singleton") {
    throw new Error(`Unknown atlas district layout: ${kind}`);
  }

  x += offsets[subsystem.id]?.x ?? 0;
  z += offsets[subsystem.id]?.z ?? 0;

  return {
    x,
    z,
    width: archetype.width,
    depth: archetype.depth,
    facadeHeight: archetype.height,
    crownHeight: archetype.crownHeight,
    height: archetype.height + archetype.crownHeight,
    districtId: district.id,
    archetypeId: detail.archetype,
  };
}

export function atlasDetail(id) {
  const detail = ATLAS_SYSTEM_DETAIL[id];
  if (!detail) {
    throw new Error(`Missing atlas detail for subsystem: ${id}`);
  }
  return detail;
}
