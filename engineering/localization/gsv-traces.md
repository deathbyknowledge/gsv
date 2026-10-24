# "GSV" traces, by surface

Every user-visible or agent-echoed occurrence of the old brand, collected on 2026-10-20 from the
gsv worktree `localization-pre-work` (`origin/main` 4a4cf996e) and the Ship Manual at pinned
revision `0dd3147`. Companion to `ia-audit.md` section 5.

Two buckets throughout:

- **A. Brand or product prose** that a person reads as the product name. These become "Ship"
  (or a plain noun such as "your cloud"), subject to the AGENTS.md rule that the runtime keeps its
  name.
- **B. Technical identifiers a person still sees**: the `gsv` CLI command, the `gsv` target id
  in pickers and prompts, `.gsv` paths, `GSV_*` environment variables, `gsvd`, `GSV.app`,
  the `@GSV` Slack bot name, `gsv-manual`, `gsv-pair1_` codes, `gsv.space` links. AGENTS.md
  keeps most of these. They are listed so the decision is explicit per item.

## Reproducible raw counts

Whole-word, case-sensitive "GSV", excluding tests, node_modules and build output. These are raw
token counts; the per-surface sections below separate brand prose from identifiers, comments and
code.

```
manual (pinned)                  8 occurrences in   4 files
docs/ (prose, incl. code)      137 occurrences in  31 files
web/src                         22 occurrences in  17 files
web/index.html                   0 occurrences in   0 files
extension/                       7 occurrences in   6 files
workers/adapters                51 occurrences in  17 files
workers/installations            1 occurrences in   1 files
gateway prompts                 19 occurrences in   9 files
skills/                         15 occurrences in   4 files
man pages                       18 occurrences in   1 files
host/apps/cli                    6 occurrences in   3 files
host/apps/desktop                1 occurrences in   1 files
host/apps/machine               24 occurrences in   4 files
```

Script (run from the worktree root; pass the manual snapshot directory as the first argument):

```zsh
#!/bin/zsh
# Reproducible per-surface counts of the case-sensitive word "GSV" in user-facing or
# agent-facing text. Excludes tests, node_modules, dist, lockfiles. Run from the worktree root.
# Usage: zsh gsv-count.sh [manual-snapshot-dir]
set -u
MANUAL=${1:-}
count() { # label, then grep args
  local label=$1; shift
  local n; n=$(grep -rwo "GSV" "$@" 2>/dev/null | wc -l | tr -d ' ')
  local f; f=$(grep -rlw "GSV" "$@" 2>/dev/null | wc -l | tr -d ' ')
  printf '%-28s %5s occurrences in %3s files\n' "$label" "$n" "$f"
}
X=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-desktop --exclude-dir=target --exclude-dir=test --exclude-dir=tests --exclude-dir=test-integration --exclude-dir=__tests__ --exclude='*.test.*' --exclude='*.spec.*' --exclude='*.lock' --exclude='package-lock.json')
[ -n "$MANUAL" ] && count "manual (pinned)" "$MANUAL" --include='*.md'
count "docs/ (prose, incl. code)" docs --include='*.md' "${X[@]}"
count "web/src"            web/src --include='*.ts' --include='*.tsx' --include='*.html' --include='*.css' "${X[@]}"
count "web/index.html"     web/index.html
count "extension/"         extension/src extension/public extension/*.html --include='*.ts' --include='*.html' --include='*.json' "${X[@]}"
count "workers/adapters"   workers/adapters --include='*.ts' --include='*.yaml' --include='*.yml' "${X[@]}"
count "workers/installations" workers/installations/src --include='*.ts' --include='*.html' "${X[@]}"
count "gateway prompts"    workers/gateway/src/prompts --include='*.md' --include='*.ts' "${X[@]}"
count "skills/"            skills --include='*.md'
count "man pages"          workers/gateway/src/drivers/native/man-pages.ts
count "host/apps/cli"      host/apps/cli/src --include='*.rs' "${X[@]}"
count "host/apps/desktop"  host/apps/desktop --include='*.rs' --include='*.json' --include='*.plist' "${X[@]}"
count "host/apps/machine"  host/apps/machine/src --include='*.rs' "${X[@]}"
```

## Headline

| Surface | Bucket A (brand prose, user-facing) | Notes |
|---|---|---|
| Ship Manual (pinned) | 5 sentences + 1 deliberate heading/rule | plus the stale `gsv.space` domain in 3 places |
| Instrument web UI | 0 rendered | one Windows folder name "GSV folder"; stale comments claim "(N) GSV" tab title and a "GSV" galaxy glyph that no longer render |
| Docs site | 111 outside code fences, 104 of them on architecture/reference pages | 7 on user pages, 3 deliberate |
| Browser extension | 5 | HTML `<title>`s "Your GSV", "GSV Viewer", "GSV Browser Target Recorder"; CSS-uppercased "gsv" fact label |
| Messaging adapters | about 38 | every pairing reply, Slack "GSV for Slack", WhatsApp Meta template, shared-channel prefix; Slack bot name `GSV` |
| Accounts pages | 1 | admin `<title>` "· GSV registry" |
| CLI | 2 in help + 3 in shared crates/installers | "invitation from GSV", "GSV Desktop" |
| Desktop host | 1 + packaging fallback | dev plist "Dictate into GSV"; CFBundleName "GSV" for locales without an lproj |
| Machine daemon | about 13 | every update/diagnostic notice "GSV {release} is available…", "GSV machine driver daemon" |
| Gateway prompts and skills | about 25 | "GSV's first-boot onboarding guide", "GSV Web Desktop", skill descriptions; the rule itself in `01-gsv.md` |
| Man pages and tool descriptions | about 30 | "GSV filesystem", "this GSV's own mailbox", sample email "Hello from GSV" |



---

# Surface A: Ship Manual (pinned 0dd3147)

### 5. GSV traces

Commands run from the snapshot root (`manual-0dd3147/`):
- `grep -rn 'GSV' --include='*.md' .` → **8 lines / 8 occurrences** (`grep -ron … | wc -l` = 8)
- `grep -rn 'gsv' --include='*.md' .` → **60 lines / 63 occurrences**
- `wiki.json` (not .md): 2 more lowercase occurrences (`"kind": "gsv.wiki"`, `"id": "gsv-manual"`).

**A. Brand/product prose or label (would become "Ship")**
- manual/pages/devices-workplaces/index.md:10 — "Save useful files to GSV before a temporary computer stops."
- manual/pages/devices-workplaces/cloud-computers.md:31 — "Run GSV management commands on `gsv`; run Python, Node.js, and installed software on the computer target."
- manual/pages/devices-workplaces/cloud-computers.md:66 — "Preserve scripts or source needed for later edits there too; a [GSV repository](../files-knowledge/repositories.md) is useful for reusable projects." (the target page calls these "Ship Repositories")
- manual/pages/devices-workplaces/cloud-computers.md:86 — "Keep working notes in GSV."
- manual/pages/reference/shell-codemode-network.md:18 — "Run GSV management commands on `gsv`; use a computer target for Python, Node.js, and installed software."
- manual/pages/orientation.md:82 — heading "Ship And The GSV Runtime" (deliberate; explains the runtime name)
- manual/pages/orientation.md:84 — "Ship is the product name. GSV remains the runtime name and appears in the `gsv` target, protocol and package identifiers, and `.gsv` folders." (deliberate)

**B. Technical identifiers the user still sees**
- Stale public domain `gsv.space`, which conflicts with `ship.space` at orientation.md:17–18, contacts.md:31, email.md:5:
  - manual/pages/integrations/index.md:23 — "Your Ship has its own address (`<handle>@gsv.space` on the public service; `mail address` prints the exact one)…"
  - manual/pages/apps-desktop/desktop-surfaces-and-apps.md:87 — "A handle such as `esteve` or `@esteve` opens that person’s profile on `gsv.space`."
  - manual/pages/devices-workplaces/browser-targets.md:29 — "[click here to download the extension](https://gsv.space/browser)." (the agent shares this URL with users)
- Windows default workspace folder: manual/pages/devices-workplaces/index.md:60 — "Its default workspace is `%USERPROFILE%\GSV`"
- Manual wiki id `gsv-manual` (the agent may cite it to users): manual/index.md:51, :52; manual/pages/orientation.md:77; manual/pages/reference/index.md:37, :38, :39; manual/pages/files-knowledge/repositories.md:32 ("`gsv-manual` is the reference for using Ship."), :37, :38; manual/wiki.json:4 (`"id": "gsv-manual"`), :2 (`"kind": "gsv.wiki"`).
- Contact invite code prefix: manual/pages/integrations/contacts.md:64 — `contact invite accept 'gsv-contact-v1:...' --handling manual` (users see and paste codes beginning `gsv-contact-v1:`).
- `gsv` target in prose and pickers:
  - manual/pages/apps-desktop/desktop-surfaces-and-apps.md:61 — "Chat's composer starts on **your cloud** (`gsv`)."
  - manual/pages/devices-workplaces/targets-copy.md:5 — "`gsv` means the installation itself."
  - manual/pages/agents-assistants/ledger.md:21 — "where: a target id, or `gsv` for the installation itself;" (shown in Settings → Logs)
  - manual/pages/settings/ai-voice-approvals.md:62 — "`target` scopes a rule: omit it for every target, `gsv` for the installation itself…"; :66 — "run automatically on `gsv` and Ship-provisioned cloud browsers"
  - manual/pages/apps-desktop/index.md:45 — "On the `gsv` target it uses:"
  - manual/pages/devices-workplaces/index.md:26 — "then run on `gsv`:"
  - manual/pages/devices-workplaces/browser-targets.md:25 — "on `gsv`."; :55 — "Find a suitable existing browser on `gsv`:"; :63 — "check `instance catalog` on `gsv`"
  - manual/pages/devices-workplaces/cloud-browsers.md:28 — "On the `gsv` target:"; :81 — "…`--wait` on `gsv`."; :135 — "On `gsv`, request human control…"
  - manual/pages/devices-workplaces/cloud-computers.md:18, :31, :32, :38, :65 ("home on `gsv`"), :70, :87
  - manual/pages/integrations/adapters-routing.md:16 — "Run `messenger list` on `gsv`"
  - manual/pages/files-knowledge/context-files-knowledge.md:90 — "…`--full` on `gsv`"
  - manual/pages/reference/command-map.md:21, :22, :23, :24, :25 — "… on `gsv`"
  - manual/pages/reference/shell-codemode-network.md:18 — "Run GSV management commands on `gsv`"
  - manual/pages/orientation.md:84 — "appears in the `gsv` target"
- `gsv` external CLI named in prose:
  - manual/pages/orientation.md:85–86 — "The external CLI command remains `gsv`."
  - manual/pages/reference/command-map.md:69 — "The installed host CLI is `gsv`. Examples such as `gsv auth login`, `gsv chat`,"; :70 — "`gsv pair` and `gsv desktop` refer to that external CLI."; :71 — "without adding a `gsv` prefix."
  - manual/pages/devices-workplaces/index.md:22 — "run the `gsv pair` command it shows"; :32 — "`gsv pair CODE`"; :45 — "`gsv daemon --help`"; :70 — "`gsv daemon status`, `stop`, …"; :72 — "`gsv daemon install`"
  - manual/pages/devices-workplaces/browser-targets.md:35 — "browsers do not use the terminal's `gsv pair` command."
  - manual/pages/accounts-access/credentials-sharing.md:23 — "use `gsv auth login --username root`"; :30 — "the corresponding `gsv auth token` CLI command"
- `gsvd` service name:
  - manual/pages/devices-workplaces/index.md:53 — "Commands run as the dedicated `NT SERVICE\gsvd` account."; :68 — "If another service uses the `gsvd` registration"
  - manual/pages/apps-desktop/desktop-surfaces-and-apps.md:179 — "The computer's background machine service, `gsvd`, is independent"
- `.gsv` paths shown to users:
  - manual/pages/devices-workplaces/index.md:43 — "new installs go to `~/.gsv/bin`"
  - manual/pages/integrations/email.md:28 — "Received messages are also stored under `~/.gsv/mail/inbox/<message-id>/`"
  - manual/pages/orientation.md:85 — "and `.gsv` folders"

---



---

# Surface B: Instrument web UI, signup, desktop shell

## 5. GSV traces

Commands, run from the worktree root over `web/src/app web/src/signup web/src/desktop web/index.html`, excluding `*.test.*`/`*.spec.*`:

- `grep -rn 'GSV' …` → **148** raw hits. Almost all are `GSVClient` / `GsvClient*` types and imports, `GSV_INFERENCE_*` constants, `VITE_GSV_*` env names, and comments. Four are lines in `web/src/app/features/instrument/README.md` and `settings/README.md`, which are developer docs and never rendered.
- `grep -rnw 'gsv' …` → **1429** raw hits, nearly all `@humansandmachines/gsv` imports, `gsv-*` CSS classes and `--gsv-*` variables.
- `grep -rnP '(?<![-\w./@:])gsv(?![-\w./:])' …`, excluding comments and imports → **47** hits (target-id comparisons, defaults, and the cases listed below).
- `grep -rn 'GSV\|gsv' web/public/social web/public/manifest.webmanifest web/public/icons/INDEX.md` → only icon filenames and the developer INDEX.md (not rendered).
- Each slice grep is restated in 5.1 to 5.6.

**A. Brand/product prose or label (would become "Ship"):** none is rendered. Every user-facing brand mention on this surface already says "Ship". Stale comments that claim GSV text is shown:
- web/src/app/features/instrument/shared/tabAttention.ts:33 ` * shows the count in the tab: "(N) GSV" in the title and a dot on the favicon.` and web/src/app/features/instrument/shared/useTabAttention.ts:12 (same claim). The actual title is `(N) Ship` (web/index.html:11 + tabAttention.ts:24).
- web/src/app/features/session/backgrounds/AuthBackground.css:31 `wizard overrides it) so the forming "GSV" stays fully uncovered at any width. */`, plus AuthBackground.css:42, AuthBackground.tsx:12 and AuthLayout.tsx:47 ("GSV-forming galaxy"). The galaxy is now a plain spiral (web/src/app/features/session/backgrounds/spiralScene.ts:4,37-70) and draws no letters.
- web/src/app/features/instrument/README.md:226 (still says the title reads "(N) GSV") and :311 (describes "New to GSV" / "Already on GSV" choices). These are developer docs. No such strings exist in shipped code (`grep -rn 'New to \|Already on ' web/src` → 0), so the README is stale.
- web/src/app/features/instrument/settings/messengers/messengerPresentation.ts:348 `/** Messenger platforms GSV supports, …` (comment).

**B. Technical identifiers the user still sees:**
- web/src/desktop/DesktopMachineSetup.tsx:113: `{navigator.platform.startsWith("Win") && <p class="note">Windows asks for administrator approval … the default is the GSV folder in your user profile.</p>}`. This is the only rendered uppercase "GSV". It is the real Windows folder name, so renaming the text depends on the folder name.
- web/src/app/features/instrument/shared/DevicePairingPanel.tsx:82: `<SetupCommand text={`${draft.platform === "windows" ? "gsv.exe" : "gsv"} pair ${code}`} label="copy connect command" />`. The CLI name appears right after "install Ship" (:79).
- web/src/app/features/instrument/zen/Zen.tsx:1143: `<span class="id">@{place.id}</span>`, which shows "your cloud  @gsv" in the @-picker (id from web/src/app/features/instrument/zen/zenModel.ts:43 `CLOUD_PLACE_ID = "gsv"`).
- web/src/app/features/instrument/zen/ActivityWorking.tsx:36 and web/src/app/features/instrument/shared/ApprovalCard.tsx:37 (via web/src/app/features/instrument/shared/commandLine.tsx:3): command lines render `{user}@gsv $ cmd`. ApprovalCard.tsx:38 `<span class="where">{request.target}</span>` and :26 (full-request JSON `"target": "gsv"`).
- web/src/app/features/instrument/zen/ChatPanels.tsx:63, web/src/app/features/instrument/shared/FilePreview.tsx:69 and web/src/app/features/instrument/memory/Memory.tsx:338: "Use this file as context: @gsv /…" is prefilled into the user's own message.
- web/src/app/features/instrument/fleet/Fleet.tsx:492 `<div class="full-id">{place.id}</div>` (shows `gsv` in the cloud inspector); web/src/app/features/instrument/fleet/Fleet.tsx:454 (raw row id fallback); web/src/app/features/instrument/fleet/Fleet.tsx:497 Driver value `gsvd {version}` for machines.
- web/src/app/features/instrument/fleet/FileReader.tsx:116 `{file.target} · {file.path}` → "gsv · /path"; FileReader.tsx:130 `Delete {file.name} from {file.target}?` → "Delete x from gsv?".
- web/src/app/features/instrument/settings/LedgerLine.tsx:62 `<dt>Target</dt><dd>{line.place}</dd>` and web/src/app/features/instrument/settings/Logs.tsx:29 (`label ?? id` fallback); web/src/app/features/instrument/fleet/fleetModel.ts:442 (ledger processId falls back to "gsv" for system lines).
- web/src/app/features/instrument/settings/ModelEditor.tsx:156 `{transport} (unavailable)` prints a raw target id. web/src/app/features/instrument/settings/Permissions.tsx:84,103 and web/src/app/components/ui/agentToolApprovalOptions.ts:283-286 print raw target/capability codes next to labels.
- web/src/app/services/chat/domain/typedHistory.ts:43 `` `${pid} is waiting for your approval of ${syscall} on ${target}.` `` → "… on gsv"; typedHistory.ts:45 (`label ?? targetId`). web/src/app/services/terminal/domain/normalization.ts:75 and web/src/app/services/files/domain/paths.ts:5 default the target to "gsv", which shows in pickers that use `label || id`.
- web/src/app/domain/system/consoleSettings.ts:127 `placeholder: "gsv",` [unrendered table].
- Links: web/src/app/features/instrument/settings/messengers/messengerDocs.ts:8 `"https://github.com/deathbyknowledge/gsv/blob/main/docs/how-to/messengers.md"` (fallback for "VIEW {PLATFORM} SETUP"); web/src/signup/DesktopAppLink.tsx:7 → `https://github.com/deathbyknowledge/gsv/releases/latest`.
- Data the user may browse: web/src/app/services/memory/libraryService.ts:43 `WIKI_MANIFEST_KIND = "gsv.wiki"`, written into each wiki's `wiki.json`; web/src/app/services/gateway/stagedResources.ts:107 upload path `~/.gsv/uploads/…` (shown in file references).
- Agent-prompt text with no UI caller: web/src/app/services/memory/libraryService.ts:268,270 ("…the wiki itself must be created on gsv as a wiki repo.").
- Not visible: icon filenames `/icons/gsv-*.png` (web/public/manifest.webmanifest), storage keys `gsv.instrument.*` / `gsv.ui.*`, the IndexedDB name `gsv-owner-welcome`, and dev-only mockGateway fixtures (`place: "gsv"`).


### 5.1 Instrument shell, shared panels, Settings

Grep (non-test files of the slice): `ls web/src/app/features/instrument/*.tsx; find web/src/app/features/instrument/shared web/src/app/features/instrument/settings -name '*.ts' -o -name '*.tsx' | grep -v test | xargs grep -n "GSV"` gives **16** hits; the same with `"gsv"` gives **39** hits (imports included).

- All 16 "GSV" hits are code: `GSVClient` type (permissionService.ts:4, messengerConnectionsService.ts:10, settingsService.ts:16-55), env `VITE_GSV_PREVIEW` (Feedback.tsx:17), and comments (tabAttention.ts:33, useTabAttention.ts:12, both stale: they say the title is "(N) GSV" but it is "(N) Ship"; messengerPresentation.ts:348; messengerDocs.ts:1).
- The "gsv" hits are mostly imports, CSS classes (`gsv-cf-footer` etc. in ManagedTelegramOnboardingFlow.tsx), storage/query keys (Instrument.tsx:59, Settings.tsx:55), and the target id used in code (settingsService.ts:17, :32; ModelEditor.tsx:78, :153; modelProfiles.ts:26).

**A. Brand prose/label:** none. Every brand mention in prose in this slice already says "Ship".

**B. Technical identifiers the user still sees:**
- web/src/app/features/instrument/shared/DevicePairingPanel.tsx:82: `<SetupCommand text={`${draft.platform === "windows" ? "gsv.exe" : "gsv"} pair ${code}`} label="copy connect command" />`. This is the CLI name in the copyable connect command, right after "1 · … install Ship" (:79).
- web/src/app/features/instrument/shared/FilePreview.tsx:69: `onClick={() => onAsk(`Use this file as context: @${file.target} ${file.path}`)}`. For cloud files `file.target` is CLOUD_TARGET_ID "gsv", so the Chat prompt gets "@gsv ~/…".
- web/src/app/features/instrument/shared/ApprovalCard.tsx:37: `{line.lead === "prompt" ? commandLine(who, request.target, line.text) : …`. It renders `{who}@gsv $ cmd`. Also :38 `<span class="where">{request.target}</span>` and :26 (the JSON "full request" includes `"target": "gsv"`).
- web/src/app/features/instrument/settings/LedgerLine.tsx:62: `<div><dt>Target</dt><dd>{line.place}</dd></div>`. The "Request details" fold shows the raw "gsv".
- web/src/app/features/instrument/settings/Logs.tsx:29: `const placeLabel = (id: string) => places.find((place) => place.id === id)?.label ?? id;`. Falls back to the raw id if the target list is not loaded.
- web/src/app/features/instrument/shared/Responsibilities.tsx:155: `<DetailValue value={targetDetails} />`. A non-responsibility routine target is dumped raw (may include a target id).
- web/src/app/features/instrument/settings/messengers/messengerDocs.ts:8: `: "https://github.com/deathbyknowledge/gsv/blob/main/docs/how-to/messengers.md";`. This is the fallback link target for "VIEW {PLATFORM} SETUP" / "VIEW WHATSAPP SETUP" (ManagedTelegramOnboardingFlow.tsx:130, :219-221) when the deployment has no docsUrl or installUrl.
- web/src/app/features/instrument/settings/permissionModel.ts:33 / Permissions.tsx:84, :103: raw capability or target codes are shown beside labels (`<code>{capability}</code>`). Not "gsv" literally, but tool and target selectors may show `gsv`.


### 5.2 Chat (zen), wire, cloud browser

Grep (from `web/src/app/features/instrument`): `grep -rn "GSV" zen wire browser | grep -v .test.` → 2 hits, both type names (`GSVClient`, web/src/app/features/instrument/browser/useBrowserStream.ts:2,8), excluded. `grep -rn "gsv" zen wire browser` excluding tests, imports and `--gsv-*` CSS variables → 6 hits: web/src/app/features/instrument/zen/zenModel.ts:43, web/src/app/features/instrument/zen/glyphReveal.ts:3, web/src/app/features/instrument/zen/zen.css:515, web/src/app/features/instrument/zen/Zen.tsx:420, web/src/app/features/instrument/zen/Zen.tsx:624, web/src/app/features/instrument/browser/CloudInstances.tsx:18. The glyphReveal mask name, the CSS highlight name and the sessionStorage key never render, so they are excluded.

**A. Brand/product prose or label:** none in the slice. No user-visible "GSV" string remains in zen/, wire/ or browser/. Nearest, outside the slice: the stale comment at `web/src/app/features/instrument/shared/tabAttention.ts:33` (`shows the count in the tab: "(N) GSV" in the title`). The title it describes actually renders "(N) Ship" (`web/index.html:11` `<title>Ship</title>`).

**B. Technical id the user still sees:**
- web/src/app/features/instrument/zen/zenModel.ts:43 `export const CLOUD_PLACE_ID = "gsv";`. This id reaches the screen through:
  - web/src/app/features/instrument/zen/Zen.tsx:420 `const all = [{ id: "gsv", label: CLOUD_PLACE_LABEL, online: true }, ...]` + web/src/app/features/instrument/zen/Zen.tsx:1143 `<span class="id">@{place.id}</span>` → the @-picker shows "your cloud  @gsv"
  - web/src/app/features/instrument/zen/ActivityWorking.tsx:36 `<pre class="work-command">{commandLine(who, target, call.summary)}</pre>` → "{username}@gsv $ {command}" in every shell call that ran on the cloud (both commands run by hand and Ship's calls in the receipt timeline, web/src/app/features/instrument/zen/ReceiptTimeline.tsx:88)
  - web/src/app/features/instrument/zen/ChatPanels.tsx:63 `` onAsk(`Use this file as context: @${file.target} ${file.path}`) `` → "@gsv /path" placed in the user's own message
  - web/src/app/features/instrument/zen/zenModel.ts:55 `if (wanted === CLOUD_PLACE_ID || wanted === "cloud" || wanted === "home") return CLOUD_PLACE_ID;`: users can type "@gsv", and Ship text containing "@gsv" becomes a link (web/src/app/features/instrument/zen/zenModel.ts:701-704)
- web/src/app/features/instrument/zen/Zen.tsx:624 `activity.target === "gsv"` is logic only and does not render.


### 5.3 Fleet, Memory, People

Commands (from `web/src/app`, positional args `features/instrument/fleet features/instrument/memory features/instrument/people services/memory services/contacts`):
- `grep -rn 'GSV' "$@" | grep -v '\.test\.'` → 15 raw hits. 14 are the `GSVClient` type in imports or annotations. The 15th is a CSS comment (web/src/app/features/instrument/people/people.css:51). **No user-visible "GSV".**
- `grep -rn 'gsv' "$@" | grep -v '\.test\.'` → 104 raw hits. Almost all are `@humansandmachines/gsv` imports or `--gsv-*` CSS variables. The 11 remaining hits are listed below.

**A. Brand or product prose:** none. Every user-facing brand mention in this slice already says "Ship".

**B. Technical identifiers the user still sees:**
- web/src/app/features/instrument/fleet/fleetModel.ts:10 `export const CLOUD_TARGET_ID = "gsv";` The label is mapped to "your cloud", but the raw id is still rendered in these places:
  - web/src/app/features/instrument/fleet/Fleet.tsx:492 `<div class="full-id">{place.id}</div>` shows `gsv` in the cloud place inspector.
  - web/src/app/features/instrument/fleet/FileReader.tsx:116 `<span class="file-reader-path">{file.target} · {file.path}</span>` shows `gsv · /path`.
  - web/src/app/features/instrument/fleet/FileReader.tsx:130 `<p>Delete {file.name} from {file.target}?</p>` reads "Delete x from gsv?".
  - web/src/app/features/instrument/fleet/Fleet.tsx:454 `<div class="sub">{selected?.slice(selected.indexOf(":") + 1)}</div>` shows the raw row id, possibly `gsv`, for a missing row.
- web/src/app/features/instrument/fleet/Fleet.tsx:497 `<dd>{place.version ? \`${place.kind === "cloud" ? "gateway" : "gsvd"} ${place.version}\` : …}</dd>` is the Driver value "gsvd {version}" for machines.
- web/src/app/features/instrument/memory/Memory.tsx:338 `onAsk(\`Use this file as context: @gsv /src/repos/${collection.repo}/…\`)` puts `@gsv` into the user's prompt as visible text.
- web/src/app/features/instrument/fleet/fleetModel.ts:442 `processId: line.pid ?? (line.principalKind === "human" ? "you" : "gsv"),` is the ledger process id for system lines. It renders wherever processId is shown (Settings Logs, outside slice).
- web/src/app/features/instrument/fleet/fleetModel.ts:255 `[/^(gsv\s+)?message\b/, "sent a message"],` only matches the CLI command; nothing is rendered.
- web/src/app/services/memory/libraryService.ts:268 `"- The source directory may be on a device target, but the wiki itself must be created on gsv as a wiki repo.",` (no UI caller; agent prompt text)
- web/src/app/services/memory/libraryService.ts:270 `"- Use \`wiki db init\` on gsv to create the wiki if needed, …",` (no UI caller; agent prompt)
- web/src/app/services/memory/libraryService.ts:209, :244 `const sourceTarget = input.sourceTarget.trim() || "gsv";` feeds "Captured gsv:{path}" (:236) and "Source target: gsv" (:262). No UI caller.
- web/src/app/services/memory/libraryService.ts:325 `if (target !== "gsv") {` → "Preview is not available yet for target '{target}'." (:333). No UI caller.
- web/src/app/services/memory/libraryService.ts:43 `const WIKI_MANIFEST_KIND = "gsv.wiki";` is written into each wiki's `wiki.json` (:135), which the user can see when browsing repository files.


### 5.4 Session, signup, setup, recovery, desktop shell

Commands:
- `grep -rn "GSV" web/src/{signup,desktop,app/services/session,app/services/machines,app/services/instances,app/providers,app/App.tsx,app/main.tsx,app/features/session} web/index.html web/public/manifest.webmanifest`, excluding tests, `GSVClient` and imports: 5 hits. 1 is rendered and 4 are comments.
- `grep -rnE "\bgsv\b" …same paths`, excluding imports, `@humansandmachines`, `gsv.ui.*`/`gsv-*` storage keys and classes, and CSS: 0 rendered hits.

A. Brand/product prose or label
- None rendered. The auth-scene "GSV" glyph is gone. The galaxy is now Steve's plain spiral (web/src/app/features/session/backgrounds/spiralScene.ts:4,37-70) and draws no letters. Only stale comments still claim it forms "GSV":
  - web/src/app/features/session/backgrounds/AuthBackground.css:31 `wizard overrides it) so the forming "GSV" stays fully uncovered at any width. */`
  - web/src/app/features/session/backgrounds/AuthBackground.css:42 `so the disc + formed "GSV" mark spill past the card and leak out visibly on`
  - web/src/app/features/session/backgrounds/AuthBackground.tsx:12 `` * `galaxy` = the GSV-forming galaxy anchored LEFT (uncovered by the form) over the``
  - web/src/app/features/session/AuthLayout.tsx:47 `/** Background treatment: "galaxy" = GSV-forming galaxy + glyph stars`
  - No `content:` text exists in any slice CSS (LoginScreen.css:84 is `content: ""`).

B. Technical identifier the user still sees
- web/src/desktop/DesktopMachineSetup.tsx:113 `… Commands use a separate account with access to the configured workspace; the default is the GSV folder in your user profile.` This is the real Windows folder name, shown in Windows-only help text.
- web/src/signup/DesktopAppLink.tsx:7 `href={LATEST_RELEASE_PAGE_URL}`. It resolves to `https://github.com/deathbyknowledge/gsv/releases/latest` (asserted at DesktopAppLink.test.tsx:9). The repo name "gsv" shows on hover and on the landing page.
- Domain-dependent, not literal: "Ship address {handle}.{spaceDomain}" (OwnerWelcomeScreen.tsx:230), "{space}" (SetupScreen.tsx:47) and the host in DesktopSpaceMenu.tsx:29 show the operator domain, which can be `gsv.space` (signup/navigation.test.ts:22).
- Not visible: icon filenames `/icons/gsv-192.png` (manifest.webmanifest), IndexedDB name `gsv-owner-welcome` (signup/storage.ts:26), storage keys `gsv.ui.*`.


### 5.5 Components and domain tables (permissions, providers, settings)

Commands: `grep -rn 'GSV' web/src/app/components web/src/app/domain --include='*.ts' --include='*.tsx' | grep -v -E '\.(test|spec)\.'` → 18 hits, **0 user-visible** (15 are `GSV_INFERENCE_*`/`GSV_AI_PROVIDER_OPTION` identifiers in aiProviders.ts:2-118; 3 are comments: Surface.tsx:24, aiProviders.ts:19, consoleSettings.ts:33).
`grep -rn 'gsv' … | grep -v class/className/gsv-*/@humansandmachines/gsv` → 15 hits; user-visible: 1 (plus 2 indirect).

A. Brand prose/label: none. (Brand already reads "Ship" in: aiProviders.ts:15 "Ship included"; agentToolApprovalOptions.ts:157 "Ship computer"; consoleSettings.ts:124, 158; AsciiGalaxyScan.tsx:546.)

B. Technical id the user still sees:
- web/src/app/domain/system/consoleSettings.ts:127 — `    placeholder: "gsv",` (Origin machine field; table currently unrendered)
- Indirect: web/src/app/domain/aiProviders.ts:117-119 — `return normalized.toLowerCase() === GSV_INFERENCE_PROVIDER ? GSV_AI_PROVIDER_OPTION.label : normalized;` — maps `gsv` → "Ship included", but every other provider id is printed raw (Preferences.tsx:128 shows e.g. "workers-ai / …").
- Indirect: web/src/app/components/ui/agentToolApprovalOptions.ts:283 — `return target.platform ? \`${target.route} · ${target.platform}\` : target.route;` and :286 `return known?.label?.trim() || target;` — an unknown target id (could be `gsv`-family ids) is printed raw.
- Non-visible but persisted: useColorTheme.ts:12 `const THEME_KEY = "gsv.instrument.theme";` (localStorage key, not rendered).


### 5.6 Services (chat, voice, terminal, files, system)

Grep commands:
- `grep -rn "GSV" web/src/app/services web/src/app/testing` (excluding the five sibling dirs, *.test.*, and lines with import / GSVClient / GsvClient / GsvClientError / GSV_): **0 user-visible hits.** All hits are type and import names, e.g. `GSVClient` in web/src/app/services/feedback/shipActivity.ts:1 and :24.
- `grep -rn '"gsv"'`: 14 hits (12 in services + 5 in mockGateway place fixtures). All are target-id comparisons or defaults in code, none printed directly.
- `gsv-console`, `gsv-ui-session`, `gsv-unsaved-guard-layer`: query keys, a token label in the mock, a CSS class. Not rendered.

A. Brand prose or label: **none.**

B. Technical id the user still sees (indirectly):
- web/src/app/services/terminal/domain/normalization.ts:75 `return value.length > 0 ? value : "gsv";` (default terminal target). Shown wherever a picker prints `target.id` or uses `label || id` (:89), so "gsv" appears if the gateway sends no label.
- web/src/app/services/files/domain/paths.ts:5 `return value.length > 0 ? value : "gsv";`; web/src/app/services/files/domain/normalization.ts:100 `label: asString(item.label) ?? id,`. Same risk in the Files target picker.
- web/src/app/services/chat/domain/typedHistory.ts:43 `` `${event.payload.pid} is waiting for your approval of ${event.payload.syscall} on ${event.payload.target}.` `` prints the raw target id, so "on gsv" for your cloud.
- web/src/app/services/chat/domain/typedHistory.ts:45 `` `${event.payload.label ?? event.payload.targetId} ${event.payload.event}.` `` falls back to the raw targetId (could be "gsv").
- web/src/app/services/gateway/mockGateway.ts:169/206/210/211/238 `place: "gsv"`: dev-only mock fixtures, resolved to a place name by the UI. Not shipped.
- web/src/app/services/platform/BrowserVoiceControls.tsx:56 download filename `ship-recording.{ext}` is already "ship", not gsv. Noted for completeness.




---

# Surface C: human docs site (docs/)

## 5. GSV traces

Commands used (from the worktree root):
- Fence-aware scan of every `docs/**/*.md` (lines inside ``` / ~~~ fences skipped), counting each regex match: `GSV` (case-sensitive) and `gsv` (case-sensitive). Implemented as a small Python pass (equivalent to `grep -n 'GSV'` with fenced blocks removed). Plus `grep -n 'GSV\|gsv' docs/.vitepress/config.ts docs/.vitepress/theme/components/NavTitle.vue`.
- Raw counts outside fences: **`GSV` = 213 occurrences on 200 lines in 36 files**: bucket A 111, bucket B 102 (B = `GSV_*` env vars, `VITE_GSV_*`, `GSV.app`, `%…%\GSV\…` paths, `[GSV EVENT]`, `GSV_MESSAGE`, `@GSV`). Inside fences: 216 more (not listed). **`gsv` = 279 occurrences on 258 lines in 38 files**, all technical (the CLI command, `gsv` target, `gsvd`, `gsv-desktop`, `gsv-manual`, `.gsv` paths, package paths, GitHub URLs, the docs route `operate-gsv`). No lowercase `gsv` is used as brand prose; the user-readable cases are listed under B.
- Config/theme: `docs/.vitepress/config.ts` has no "GSV" in visible strings; it uses env vars `GSV_DOCS_ORIGIN` (:60) and `GSV_PRODUCT_URL` (:80, fallback `https://github.com/deathbyknowledge/gsv`, which is where the nav-bar "Ship" link goes). `NavTitle.vue` contains only the CSS class `nav-title-gsv` (not visible).
- Not a token match, but a brand trace: "It's named for the General Systems Vehicles in Iain M. Banks' Culture novels" (docs/get-started/faq.md:114). That is the expansion of GSV and explains the Ship name.

Per-file totals (A + B): adapter-model 13+1, agent-loop 4+2, context-and-knowledge 5+2, context-compaction 2+1, conversations 2+1, architecture/index 10+0, installation-directory 1+2, interaction-surface-bindings 1+0, process-history 0+1, process-ipc-and-scheduler 3+1, resource-references 2+0, responsibilities-and-context-epochs 2+2, rust-host-applications 2+11, security-model 8+0, services 2+0, targets 12+0, telemetry 3+1, unified-protocol-peers 7+0, faq 2+0, cloud-browsers 0+1, cloud-computers 2+0, deploy-with-alchemy 1+14, deploy 0+2, install-host-apps 0+13, messengers 0+2, operate-gsv 0+26, voice-input 0+1, cli-commands 1+13, configuration 0+1, context-files 5+0, hardware-tools 3+0, reference/index 1+0, r2-storage 1+0, routing 2+0, syscalls 12+4, websocket-protocol 2+0. User-facing pages (why, index, examples, get-started, how-to) hold only 7 bucket-A occurrences: faq.md:122, :124 (the deliberate "Is Ship different from GSV?" section), cloud-computers.md:15, :38, deploy-with-alchemy.md:18 (deliberate). The other 104 bucket-A occurrences are on architecture/reference pages.

#### Bucket A — brand/product prose (would become "Ship")

**docs/architecture/adapter-model.md** — 13 occurrence(s)

- docs/architecture/adapter-model.md:3 — "Use this page when you want to understand how GSV connects an open-ended set of external messaging systems to the same durable process model used by the CLI and Desktop."
- docs/architecture/adapter-model.md:12 — "You want to reach the same system from the Desktop, the CLI, the bundled messengers, and adapters written for services GSV has never seen."
- docs/architecture/adapter-model.md:21 — "GSV avoids that by isolating each external integration behind an adapter worker."
- docs/architecture/adapter-model.md:29 — "- translating inbound events into normalized GSV adapter messages"
- docs/architecture/adapter-model.md:30 — "- translating outbound GSV replies back into platform-specific format"
- docs/architecture/adapter-model.md:79 — "This gives GSV:"
- docs/architecture/adapter-model.md:170 — "The adapter normalizes it into a GSV adapter message."
- docs/architecture/adapter-model.md:245 — "It selects destinations through `here`, opaque GSV ids, or unambiguous generic labels rather than provider fields, and only accepts owned interactive processes."
- docs/architecture/adapter-model.md:379 — "GSV uses identity links so that a Telegram, Slack, or Discord actor can be mapped to a local uid."
- docs/architecture/adapter-model.md:443 — "This is what lets GSV keep one durable process model while still supporting multiple external surfaces."
- docs/architecture/adapter-model.md:444 — "Actor scope is important: two linked GSV users can participate in one shared group or channel without overwriting one another's process selection or destination authority."
- docs/architecture/adapter-model.md:559 — "The adapter model keeps GSV coherent."
- docs/architecture/adapter-model.md:562 — "With it, GSV can treat any provider adapter, the CLI, and the Desktop as multiple surfaces into the same computer."

**docs/architecture/agent-loop.md** — 4 occurrence(s)

- docs/architecture/agent-loop.md:3 — "The agent loop is the runtime inside a GSV process."
- docs/architecture/agent-loop.md:122 — "Changes after epoch creation are appended as ordered GSV events alongside responsibility changes; they never rewrite that epoch's prompt."
- docs/architecture/agent-loop.md:142 — "A route-less run names the GSV process history instead."
- docs/architecture/agent-loop.md:271 — "If no policy is configured, GSV defaults to:"

**docs/architecture/context-and-knowledge.md** — 5 occurrence(s)

- docs/architecture/context-and-knowledge.md:3 — "GSV keeps standing context and durable knowledge as ordinary files in versioned repositories."
- docs/architecture/context-and-knowledge.md:21 — "Memory’s **ask Ship** control adds the page’s GSV repository path to the Chat composer as ordinary editable text, preserving the existing draft and attachments."
- docs/architecture/context-and-knowledge.md:35 — "\| Filesystem substrate \| `fs.*` \| Linux-like file access across native GSV storage and routed devices."
- docs/architecture/context-and-knowledge.md:134 — "A page can cite GSV files, workspace files, or routed device paths without embedding the source corpus into the wiki."
- docs/architecture/context-and-knowledge.md:183 — "Shared system entries explain GSV-specific decisions: choosing targets, interpreting message origins and runtime events, sending human-facing output through Send, returning delegated results, and preserving knowledge."

**docs/architecture/context-compaction.md** — 2 occurrence(s)

- docs/architecture/context-compaction.md:3 — "GSV compacts process history when its assembled model context approaches the selected model's input budget."
- docs/architecture/context-compaction.md:144 — "Summary or archive failure stops the run explicitly; GSV does not install a content-free summary."

**docs/architecture/conversations.md** — 2 occurrence(s)

- docs/architecture/conversations.md:3 — "GSV presents one personal intelligence while retaining inspectable agent processes."
- docs/architecture/conversations.md:349 — "Chat’s `+` menu can attach a file, find a person by handle, saved name or GSV address, reference a file on a place, or stage a request to create a routine, connect a computer or start a browser."

**docs/architecture/index.md** — 10 occurrence(s)

- docs/architecture/index.md:3 — "GSV is a personal cloud computer: an always-on operating system for humans, machines, services, and agents."
- docs/architecture/index.md:17 — "If you are new to GSV and just want a running deployment, start with [Get Started](../get-started/)."
- docs/architecture/index.md:41 — "The Gateway Worker and Kernel Durable Object are the GSV kernel."
- docs/architecture/index.md:106 — "GSV exposes a virtual filesystem through `GsvFs`."
- docs/architecture/index.md:125 — "The native GSV runtime, a connected computer, a browser profile, or a service account can provide one when it implements a coherent subset of the syscall surface."
- docs/architecture/index.md:160 — "ripgit is GSV's built-in Git service and repository API."
- docs/architecture/index.md:171 — "GSV uses repositories for more than source control:"
- docs/architecture/index.md:214 — "GSV needs to be reachable when no personal machine is online."
- docs/architecture/index.md:240 — "GSV favors stable OS-like interfaces over implementation leakage."
- docs/architecture/index.md:250 — "These rules are what make GSV feel like a cloud computer instead of a collection of chat integrations."

**docs/architecture/installation-directory.md** — 1 occurrence(s)

- docs/architecture/installation-directory.md:139 — "The managed composition uses this to prevent GSV mailboxes from registering more Spaces."

**docs/architecture/interaction-surface-bindings.md** — 1 occurrence(s)

- docs/architecture/interaction-surface-bindings.md:4 — "The original universal-routing-graph design predated GSV's canonical Conversation model and treated a Process as the durable conversation."

**docs/architecture/process-ipc-and-scheduler.md** — 3 occurrence(s)

- docs/architecture/process-ipc-and-scheduler.md:3 — "GSV processes are durable agent processes."
- docs/architecture/process-ipc-and-scheduler.md:146 — "During an adapter turn it additionally exposes the current surface as an opaque GSV destination id."
- docs/architecture/process-ipc-and-scheduler.md:290 — "Standing responsibility definitions describe the work GSV must continue to own."

**docs/architecture/resource-references.md** — 2 occurrence(s)

- docs/architecture/resource-references.md:6 — "GSV should represent files and media once, as authorized resource references, and move their bytes only when a consumer resolves those references."
- docs/architecture/resource-references.md:56 — "It must not be the GSV transport, history, or storage format."

**docs/architecture/responsibilities-and-context-epochs.md** — 2 occurrence(s)

- docs/architecture/responsibilities-and-context-epochs.md:3 — "GSV represents unresolved work with one Kernel-owned primitive: a responsibility, abbreviated `r12y`."
- docs/architecture/responsibilities-and-context-epochs.md:310 — "- ordered responsibility and GSV event deltas;"

**docs/architecture/rust-host-applications.md** — 2 occurrence(s)

- docs/architecture/rust-host-applications.md:3 — "GSV ships three sibling host applications."
- docs/architecture/rust-host-applications.md:161 — "## GSV Desktop"

**docs/architecture/security-model.md** — 8 occurrence(s)

- docs/architecture/security-model.md:3 — "GSV is powerful personal infrastructure."
- docs/architecture/security-model.md:17 — "Anyone who can change Worker code, Durable Object state, Worker secrets, R2 buckets, or bound services can effectively control the GSV instance."
- docs/architecture/security-model.md:46 — "The resulting grant independently lists syscalls the peer may call, signals it may receive, and syscalls GSV may route back to it."
- docs/architecture/security-model.md:106 — "MCP server tokens are managed by the Kernel's composed MCP client manager; GSV keeps separate user ownership metadata so MCP listing and tool calls are scoped before CodeMode or shell can use them."
- docs/architecture/security-model.md:155 — "Native GSV file access uses a virtual filesystem."
- docs/architecture/security-model.md:226 — "Adapters bridge external messaging systems into GSV."
- docs/architecture/security-model.md:296 — "## What GSV Does Not Protect Against"
- docs/architecture/security-model.md:298 — "GSV does not protect against a compromised Cloudflare account, deployed Worker, R2 bucket, Durable Object state, ripgit service, or LLM provider."

**docs/architecture/services.md** — 2 occurrence(s)

- docs/architecture/services.md:3 — "GSV includes public Accounts and inference Workers alongside its Gateway."
- docs/architecture/services.md:153 — "Human-only `sys.browser.watch` and `sys.browser.input` expose the same browser through GSV's authenticated transport."

**docs/architecture/targets.md** — 12 occurrence(s)

- docs/architecture/targets.md:3 — "A GSV target is an addressable, Unix-shaped capability environment."
- docs/architecture/targets.md:4 — "It may be backed by the native GSV runtime, a physical computer, a browser profile, or an external service account."
- docs/architecture/targets.md:9 — "It is defined by the coherent environment it makes available through GSV primitives."
- docs/architecture/targets.md:24 — "\| **Target** \| An addressable capability environment offered through coherent GSV primitives."
- docs/architecture/targets.md:70 — "GSV currently projects these environments:"
- docs/architecture/targets.md:107 — "The paired user's OAuth token supplies read visibility; mutations use the installed GSV app identity, and the adapter retains both credentials and provider policy."
- docs/architecture/targets.md:138 — "The messaging projection admits inbound human messages and delivers canonical GSV Messages through normalized adapter surfaces."
- docs/architecture/targets.md:143 — "`message send` remains the operation that commits a user-visible GSV Message and delivers it to a conversation surface."
- docs/architecture/targets.md:149 — "The Kernel owns the caller's GSV capability check, target visibility, generic routing, cancellation, and body ownership."
- docs/architecture/targets.md:154 — "Pairing a human proves the right to enter GSV from the paired identity and observed surfaces; it does not automatically grant that person's GSV every workspace resource visible to a shared bot token."
- docs/architecture/targets.md:155 — "Pairing a human proves the right to enter GSV from the paired identity and observed surfaces; it does not automatically grant that person's GSV every workspace resource visible to a shared bot token."
- docs/architecture/targets.md:164 — "Target-originated messages must visibly attribute the paired person's GSV even though the provider records the installed app as their technical author."

**docs/architecture/telemetry.md** — 3 occurrence(s)

- docs/architecture/telemetry.md:3 — "GSV exposes an optional, provider-neutral telemetry seam for deployment operators."
- docs/architecture/telemetry.md:101 — "Backend knowledge and credentials stay in that deployment, not in GSV core."
- docs/architecture/telemetry.md:172 — "Production log alerts should filter the production environment, GSV services and error/fatal severity; they must not exclude all `runtime.invocation.failed` events."

**docs/architecture/unified-protocol-peers.md** — 7 occurrence(s)

- docs/architecture/unified-protocol-peers.md:5 — "GSV has one request, response, signal, body, and cancellation model."
- docs/architecture/unified-protocol-peers.md:23 — "- what it can implement for GSV; and"
- docs/architecture/unified-protocol-peers.md:101 — "- `calls`: syscall patterns the peer may send to GSV;"
- docs/architecture/unified-protocol-peers.md:102 — "- `signals`: asynchronous signal names GSV may send to the peer;"
- docs/architecture/unified-protocol-peers.md:103 — "- `implements`: syscall patterns GSV may route to the peer."
- docs/architecture/unified-protocol-peers.md:208 — "A peer that advertises implementations can receive `req` frames from GSV and return ordinary `res` frames."
- docs/architecture/unified-protocol-peers.md:315 — "GSV already needs protocol-specific syscall contracts, streamed bodies, explicit signals, and hibernation-safe routing."

**docs/get-started/faq.md** — 2 occurrence(s)

- docs/get-started/faq.md:122 — "## Is Ship different from GSV?"
- docs/get-started/faq.md:124 — "GSV is still the underlying runtime and appears in technical identifiers, the `gsv` target, `.gsv` folders and the `gsv` CLI command."

**docs/how-to/cloud-computers.md** — 2 occurrence(s)

- docs/how-to/cloud-computers.md:15 — "Save useful files in the owner's home on `gsv`, using a GSV repository for reusable source when appropriate."
- docs/how-to/cloud-computers.md:38 — "GSV management commands belong on `gsv`; Python, Node.js and installed software run on the computer target."

**docs/how-to/deploy-with-alchemy.md** — 1 occurrence(s)

- docs/how-to/deploy-with-alchemy.md:18 — "The product is Ship; the GSV runtime and infrastructure identifiers stay stable."

**docs/reference/cli-commands.md** — 1 occurrence(s)

- docs/reference/cli-commands.md:247 — "`mail address` prints this GSV's own address, the space handle at the installation's managed-mail domain (for example `<handle>@gsv.space` on the public service), which the runtime facts also list; `man --search` ranks `mail` for sign-up, verification code, receipt and tracking questions, and reports it unavailable when the installation has no mailbox."

**docs/reference/context-files.md** — 5 occurrence(s)

- docs/reference/context-files.md:3 — "GSV assembles process prompts from explicit context providers, not from hidden agent state."
- docs/reference/context-files.md:14 — "GSV can also assemble a compact skill index from layered `skills.d` directories."
- docs/reference/context-files.md:140 (x2) — "Use the GSV target for GSV filesystem paths."
- docs/reference/context-files.md:157 — "Standing runtime context names the product Ship while retaining GSV technical identifiers and `.gsv` paths."

**docs/reference/hardware-tools.md** — 3 occurrence(s)

- docs/reference/hardware-tools.md:3 — "GSV exposes one target-aware tool interface to AI processes."
- docs/reference/hardware-tools.md:224 — "They are useful for GSV control-plane work, virtual filesystem inspection, and HTTP/network operations allowed by the runtime."
- docs/reference/hardware-tools.md:233 — "The native shell also includes a `codemode` command for reusable GSV tool scripts and an `mcp` command for connected MCP servers:"

**docs/reference/index.md** — 1 occurrence(s)

- docs/reference/index.md:3 — "Use this section when you need the stable technical surface of GSV."

**docs/reference/r2-storage.md** — 1 occurrence(s)

- docs/reference/r2-storage.md:3 — "GSV uses several storage planes."

**docs/reference/routing.md** — 2 occurrence(s)

- docs/reference/routing.md:3 — "GSV routing is kernel-level message and syscall routing."
- docs/reference/routing.md:50 — "If `target` is omitted or set to `gsv`, a target-routable syscall runs in GSV's native capability environment."

**docs/reference/syscalls.md** — 12 occurrence(s)

- docs/reference/syscalls.md:3 — "Syscalls are GSV's stable operation surface."
- docs/reference/syscalls.md:37 — "The default policy allows these operations on `gsv` and GSV-provisioned cloud browsers."
- docs/reference/syscalls.md:405 — "`unknown` means the provider call may have succeeded, so GSV will not replay it and risk sending a duplicate."
- docs/reference/syscalls.md:705 — "## Contacts And Cross-GSV Requests: `contact.*`"
- docs/reference/syscalls.md:707 — "`contact.*` connects an owner on one GSV installation to an owner on another."
- docs/reference/syscalls.md:751 — "\| `contact.request.list` \| Lists structured incoming and outgoing cross-GSV requests."
- docs/reference/syscalls.md:1092 — "`proc.*` controls GSV AI processes."
- docs/reference/syscalls.md:1497 — "In the native GSV shell, each filesystem mutation under a writable `/src/repos/{owner}/{repo}` path commits immediately to that repo's configured ref."
- docs/reference/syscalls.md:1733 — "Redirects must target `/oauth/callback` on the deployed GSV origin."
- docs/reference/syscalls.md:1738 — "\| `sys.mcp.remove` \| `handleSysMcpRemove` \| Removes a caller-owned MCP server from GSV ownership metadata and the underlying MCP client manager."
- docs/reference/syscalls.md:2303 — "The actor dimension allows multiple linked GSV users to use one shared external surface without overwriting one another."
- docs/reference/syscalls.md:2366 — "Schedule records live in Kernel SQLite, GSV computes timezone-aware next fire times, and Cloudflare Agent schedules are used only as concrete wake-ups."

**docs/reference/websocket-protocol.md** — 2 occurrence(s)

- docs/reference/websocket-protocol.md:287 — "- `implements` lists syscall patterns GSV may route back to this peer."
- docs/reference/websocket-protocol.md:312 — "\| `contact.*` \| Kernel-owned contact pairing, authenticated cross-GSV delivery, requests, and revocation \|"

#### Bucket B — technical identifiers a user/operator still sees

**docs/architecture/adapter-model.md** — 1 occurrence(s)

- docs/architecture/adapter-model.md:239 — `GSV_MESSAGE` — "registers files for the next current-conversation message. The `Send` tool, or a literal `message send <<'GSV_MESSAGE'` block, sends without finishing the run"

**docs/architecture/agent-loop.md** — 2 occurrence(s)

- docs/architecture/agent-loop.md:193 — `GSV_MESSAGE` — "`message send <<'GSV_MESSAGE'` block, `yield`, or `message send ... && yield` is the same action as a"
- docs/architecture/agent-loop.md:198 — `[GSV EVENT]` — "- Ordinary assistant text in a human-facing run that stops without yielding causes a `[GSV EVENT]`"

**docs/architecture/context-and-knowledge.md** — 2 occurrence(s)

- docs/architecture/context-and-knowledge.md:118 (x2) — `GSV_MANUAL_BOOTSTRAP_UPSTREAM`, `GSV_MANUAL_BOOTSTRAP_REF` — "`GSV_MANUAL_BOOTSTRAP_UPSTREAM` and `GSV_MANUAL_BOOTSTRAP_REF`. Mutable custom refs"

**docs/architecture/context-compaction.md** — 1 occurrence(s)

- docs/architecture/context-compaction.md:56 — `[GSV EVENT]` — "`[GSV EVENT]` per context epoch so the agent can preserve durable knowledge,"

**docs/architecture/conversations.md** — 1 occurrence(s)

- docs/architecture/conversations.md:135 — `[GSV EVENT]` — "`[GSV EVENT]` correction naming `Send`, up to three times, with the tool set unchanged so the cached"

**docs/architecture/installation-directory.md** — 2 occurrence(s)

- docs/architecture/installation-directory.md:83 — `GSV_OWNER_SIGNUP_URL` — "the same recovery signal. The operator may bind `GSV_OWNER_SIGNUP_URL` to its"
- docs/architecture/installation-directory.md:131 — `GSV_SIGNUP_ENABLED` — "the deployment composition (`GSV_SIGNUP_ENABLED=true` in Accounts). Commercial"

**docs/architecture/process-history.md** — 1 occurrence(s)

- docs/architecture/process-history.md:41 — `[GSV EVENT]` — "Model-facing events start with `[GSV EVENT]` before any origin annotations."

**docs/architecture/process-ipc-and-scheduler.md** — 1 occurrence(s)

- docs/architecture/process-ipc-and-scheduler.md:52 — `[GSV EVENT]` — "the `[GSV EVENT]` envelope. Process IPC uses identified `Delegated task from…`"

**docs/architecture/responsibilities-and-context-epochs.md** — 2 occurrence(s)

- docs/architecture/responsibilities-and-context-epochs.md:34 — `[GSV EVENT]` — "Not every `[GSV EVENT]` is an obligation. For example, returning from a Work session"
- docs/architecture/responsibilities-and-context-epochs.md:194 — `[GSV EVENT]` — "persisted as one bounded `[GSV EVENT]` in the Process Activity, and the event message"

**docs/architecture/rust-host-applications.md** — 11 occurrence(s)

- docs/architecture/rust-host-applications.md:67 — `%ProgramFiles%\GSV\service` — "to `%ProgramFiles%\GSV\service`, and defaults to the passwordless virtual"
- docs/architecture/rust-host-applications.md:79 — `%USERPROFILE%\GSV` — "The default Windows workspace is `%USERPROFILE%\GSV`."
- docs/architecture/rust-host-applications.md:109 (x2) — `GSV_GSVD_PATH` — "consulting `GSV_GSVD_PATH` or `PATH`. The enrolling process locks and checks that"
- docs/architecture/rust-host-applications.md:118 — `%ProgramData%\GSV\daemon` — "`%ProgramData%\GSV\daemon` holds the daemon-only enrollment and"
- docs/architecture/rust-host-applications.md:126 — `%ProgramData%\GSV\owner.sid` — "The authoritative owner SID lives separately at `%ProgramData%\GSV\owner.sid`,"
- docs/architecture/rust-host-applications.md:298 — `GSV_INSTALL_DIR` — "`%LOCALAPPDATA%\Programs\gsv\bin` on Windows) unless `GSV_INSTALL_DIR` says"
- docs/architecture/rust-host-applications.md:315 — `GSV_VERSION` — "pinned with `GSV_VERSION` to the release the gateway named (`vX.Y.Z` on the"
- docs/architecture/rust-host-applications.md:348 — `GSV.app` — "`GSV.app` and ZIP containing Desktop, CLI, daemon, helpers, application"
- docs/architecture/rust-host-applications.md:370 — `GSV_WINDOWS_SIGNING_THUMBPRINT` — "`host/scripts/sign-windows.ps1` uses `GSV_WINDOWS_SIGNING_THUMBPRINT` when the"
- docs/architecture/rust-host-applications.md:383 — `GSV.app` — "and stored paths remain stable. macOS keeps `GSV.app` on disk so an upgrade"

**docs/architecture/telemetry.md** — 1 occurrence(s)

- docs/architecture/telemetry.md:84 — `GSV_TELEMETRY_ENABLED` — "Producers emit one structured record only when `GSV_TELEMETRY_ENABLED` is set by"

**docs/how-to/cloud-browsers.md** — 1 occurrence(s)

- docs/how-to/cloud-browsers.md:411 — `GSV_DEV_BROWSER_VERSION` — "for Testing build, set `GSV_DEV_BROWSER_VERSION` to its full version and restart"

**docs/how-to/deploy-with-alchemy.md** — 14 occurrence(s)

- docs/how-to/deploy-with-alchemy.md:19 — `GSV_DOMAIN` — "`GSV_DOMAIN` chooses the domain for new installations. Configure public UI values"
- docs/how-to/deploy-with-alchemy.md:20 — `GSV_PUBLIC_CONFIG` — "with `GSV_PUBLIC_CONFIG`, a JSON object containing optional `operatorName`,"
- docs/how-to/deploy-with-alchemy.md:25 — `GSV_DOMAIN_ALIASES` — "For a domain transition, `GSV_DOMAIN_ALIASES='["old.example"]'` lets Accounts"
- docs/how-to/deploy-with-alchemy.md:37 — `GSV_OWNER_ORIGIN_ALIASES` — "changing a live domain. `GSV_OWNER_ORIGIN_ALIASES` accepts a JSON array of additional"
- docs/how-to/deploy-with-alchemy.md:48 — `VITE_GSV_PUBLIC_CONFIG` — "Desktop release builds accept the same JSON through `VITE_GSV_PUBLIC_CONFIG`;"
- docs/how-to/deploy-with-alchemy.md:49 — `GSV_PUBLIC_CONFIG` — "the release workflow reads the repository variable `GSV_PUBLIC_CONFIG`. After"
- docs/how-to/deploy-with-alchemy.md:51 — `GSV_DOCS_ORIGIN` — "domain, users enter a full address. Documentation builds accept `GSV_DOCS_ORIGIN`"
- docs/how-to/deploy-with-alchemy.md:52 — `GSV_PRODUCT_URL` — "for the sitemap and `GSV_PRODUCT_URL` for the product link."
- docs/how-to/deploy-with-alchemy.md:56 — `GSV_OPERATOR_UPDATES_FILE` — "Set `GSV_OPERATOR_UPDATES_FILE` to an operator-owned JSON file, or pass an"
- docs/how-to/deploy-with-alchemy.md:71 — `GSV_OPERATOR_UPDATES` — "The Gateway binding is `GSV_OPERATOR_UPDATES`. The catalog is limited to 32 briefs."
- docs/how-to/deploy-with-alchemy.md:111 — `GSV_ADMIN_ORIGIN` — "including `GSV_ADMIN_ORIGIN`, the Worker name prefix, Cloudflare Access and"
- docs/how-to/deploy-with-alchemy.md:119 — `GSV_INSTALLATIONS_DATABASE_ID` — "`GSV_INSTALLATIONS_DATABASE_ID`. From a local controlling terminal, supply"
- docs/how-to/deploy-with-alchemy.md:141 — `GSV_OWNER_EMAIL_FROM` — "with `GSV_OWNER_EMAIL_FROM`, or the supported OIDC provider inputs, as described"
- docs/how-to/deploy-with-alchemy.md:146 — `GSV_ADAPTERS` — "No messenger adapters are enabled by default. Set `GSV_ADAPTERS` to a"

**docs/how-to/deploy.md** — 2 occurrence(s)

- docs/how-to/deploy.md:19 — `GSV_DOMAIN` — "1. Authenticate Alchemy and configure your Cloudflare account, `GSV_DOMAIN` and"
- docs/how-to/deploy.md:20 — `GSV_ZONE_ID` — "`GSV_ZONE_ID`."

**docs/how-to/install-host-apps.md** — 13 occurrence(s)

- docs/how-to/install-host-apps.md:37 — `GSV_NO_LAUNCH` — "Ship Desktop automatically. Set `GSV_NO_LAUNCH=1` to skip opening it. Headless,"
- docs/how-to/install-host-apps.md:61 — `GSV_CHANNEL` — "Use `GSV_CHANNEL=dev` for the moving development channel, or set"
- docs/how-to/install-host-apps.md:62 — `GSV_VERSION` — "`GSV_VERSION=vX.Y.Z` to install an immutable release tag."
- docs/how-to/install-host-apps.md:70 — `GSV_NO_ANIMATION` — "Redirected output and CI keep ordinary text output. Set `GSV_NO_ANIMATION=1`"
- docs/how-to/install-host-apps.md:110 — `GSV_NO_MODIFY_PATH` — "Windows it is the user `Path` in the registry. Set `GSV_NO_MODIFY_PATH=1` to"
- docs/how-to/install-host-apps.md:114 — `GSV_NO_MODIFY_PATH` — "Unless `GSV_NO_MODIFY_PATH=1`, the installer also exports the updated `PATH`"
- docs/how-to/install-host-apps.md:121 — `GSV_INSTALL_DIR` — "`GSV_INSTALL_DIR` overrides the destination. On Unix, a directory this user cannot"
- docs/how-to/install-host-apps.md:124 — `GSV_INSTALL_DIR` — "On Unix, an existing installation stays where it is. When `GSV_INSTALL_DIR` is unset the"
- docs/how-to/install-host-apps.md:152 — `%USERPROFILE%\GSV` — "`%USERPROFILE%\GSV`. Choose a folder whose permissions your user can change"
- docs/how-to/install-host-apps.md:164 — `%ProgramFiles%\GSV\service\gsvd.exe` — "The protected executable lives at `%ProgramFiles%\GSV\service\gsvd.exe`."
- docs/how-to/install-host-apps.md:165 — `%ProgramData%\GSV\daemon` — "Daemon enrollment and logs live at `%ProgramData%\GSV\daemon`; CLI and Desktop"
- docs/how-to/install-host-apps.md:283 — `GSV.app` — "`gsv-desktop-darwin-x64.zip`, each containing `GSV.app` with the CLI, daemon and"
- docs/how-to/install-host-apps.md:322 — `GSV.app` — "displayed as Ship while the bundle remains `GSV.app` on disk, so replacing it"

**docs/how-to/messengers.md** — 2 occurrence(s)

- docs/how-to/messengers.md:70 — `@GSV` — "3. Mention `@GSV` in a channel, or send the app a direct message. Ship sends a"
- docs/how-to/messengers.md:75 — `@GSV` — "6. Mention `@GSV` again to start a conversation. In a channel, replies remain"

**docs/how-to/operate-gsv.md** — 26 occurrence(s)

- docs/how-to/operate-gsv.md:14 — `GSV_DOMAIN` — "\| `GSV_DOMAIN` \| Base domain for installation hostnames. \|"
- docs/how-to/operate-gsv.md:15 — `GSV_ZONE_ID` — "\| `GSV_ZONE_ID` \| Cloudflare DNS zone containing that domain. \|"
- docs/how-to/operate-gsv.md:16 — `GSV_ADMIN_ORIGIN` — "\| `GSV_ADMIN_ORIGIN` \| Administration origin; defaults to `https://accounts.<domain>`. \|"
- docs/how-to/operate-gsv.md:17 — `GSV_WORKER_PREFIX` — "\| `GSV_WORKER_PREFIX` \| Physical resource name prefix; defaults to `gsv`. \|"
- docs/how-to/operate-gsv.md:18 — `GSV_ALLOW_RESOURCE_DELETION` — "\| `GSV_ALLOW_RESOURCE_DELETION` \| Explicit physical resource deletion opt-in; defaults to `false`, including in CI. \|"
- docs/how-to/operate-gsv.md:19 — `GSV_ACCESS_MODE` — "\| `GSV_ACCESS_MODE` \| `operator` or `access`; defaults to `operator`. \|"
- docs/how-to/operate-gsv.md:20 (x2) — `GSV_ACCESS_TEAM_DOMAIN`, `GSV_ACCESS_AUDIENCE` — "\| `GSV_ACCESS_TEAM_DOMAIN`, `GSV_ACCESS_AUDIENCE` \| Required for Cloudflare Access mode. \|"
- docs/how-to/operate-gsv.md:21 — `GSV_OWNER_EMAIL_FROM` — "\| `GSV_OWNER_EMAIL_FROM` \| Verified sending address for native email-code owner sign-in, My Ships and recovery. \|"
- docs/how-to/operate-gsv.md:22 — `GSV_OWNER_EMAIL_ALLOWED_RECIPIENTS` — "\| `GSV_OWNER_EMAIL_ALLOWED_RECIPIENTS` \| Optional comma-separated recipient restriction for owner verification mail, useful on staging. \|"
- docs/how-to/operate-gsv.md:23 (x3) — `GSV_OWNER_OIDC_ISSUER`, `GSV_OWNER_OIDC_CLIENT_ID`, `GSV_OWNER_OIDC_CLIENT_SECRET` — "\| `GSV_OWNER_OIDC_ISSUER`, `GSV_OWNER_OIDC_CLIENT_ID`, `GSV_OWNER_OIDC_CLIENT_SECRET` \| Optional owner identity provider for account linking and root recovery; issuer ..."
- docs/how-to/operate-gsv.md:24 — `GSV_ADAPTERS` — "\| `GSV_ADAPTERS` \| Comma-separated operator-enabled adapter IDs; empty by default. \|"
- docs/how-to/operate-gsv.md:25 (x2) — `GSV_INFERENCE_PROVIDER`, `GSV_INFERENCE_MODEL` — "\| `GSV_INFERENCE_PROVIDER`, `GSV_INFERENCE_MODEL` \| Operator default provider and model. \|"
- docs/how-to/operate-gsv.md:26 (x2) — `GSV_INFERENCE_API_KEY`, `GSV_INFERENCE_BASE_URL` — "\| `GSV_INFERENCE_API_KEY`, `GSV_INFERENCE_BASE_URL` \| Optional operator provider credentials and endpoint. \|"
- docs/how-to/operate-gsv.md:27 — `GSV_DELETION_CATALOG_FILE` — "\| `GSV_DELETION_CATALOG_FILE` \| Path to a JSON array declaring current and historical external resources for deletion; see below. \|"
- docs/how-to/operate-gsv.md:29 — `GSV_INFERENCE_MONTHLY_REQUESTS` — "Optional inference ceilings are `GSV_INFERENCE_MONTHLY_REQUESTS`,"
- docs/how-to/operate-gsv.md:30 (x2) — `GSV_INFERENCE_MONTHLY_OUTPUT_TOKENS`, `GSV_INFERENCE_MAX_OUTPUT_TOKENS` — "`GSV_INFERENCE_MONTHLY_OUTPUT_TOKENS`, `GSV_INFERENCE_MAX_OUTPUT_TOKENS` and"
- docs/how-to/operate-gsv.md:31 — `GSV_INFERENCE_MAX_DURATION_MS` — "`GSV_INFERENCE_MAX_DURATION_MS`. The default Workers AI route uses the operator's"
- docs/how-to/operate-gsv.md:71 — `GSV_SIGNUP_ENABLED` — "To let people sign up themselves, enable `GSV_SIGNUP_ENABLED` and configure"
- docs/how-to/operate-gsv.md:103 — `GSV_DELETION_CATALOG_FILE` — "including services previously enabled. `GSV_DELETION_CATALOG_FILE` supplies the"
- docs/how-to/operate-gsv.md:129 — `GSV_DEV_STATE_DIR` — "The default state directory is `.wrangler/operator-dev-state`; set `GSV_DEV_STATE_DIR` to use"

**docs/how-to/voice-input.md** — 1 occurrence(s)

- docs/how-to/voice-input.md:128 — `GSV_DESKTOP_PATH` — "speaker and prints the `GSV_DESKTOP_PATH=… gsv desktop` command. Building requires"

**docs/reference/cli-commands.md** — 13 occurrence(s)

- docs/reference/cli-commands.md:17 — `GSV_URL` — "\| `--url <URL>` \| `GSV_URL` \| Gateway WebSocket URL. Defaults to `gateway.url` in local config, then `ws://localhost:8787/ws`. \|"
- docs/reference/cli-commands.md:20 — `GSV_TOKEN` — "\| `-t, --token <TOKEN>` \| `GSV_TOKEN` \| Non-interactive credential. User commands default to the personal account; device credentials retain their enrolled username. \|"
- docs/reference/cli-commands.md:62 — `GSV_CLIENT_DEBUG` — "intelligence process. Set `GSV_CLIENT_DEBUG=1` to trace run-signal matching."
- docs/reference/cli-commands.md:215 — `GSV_PID` — "`GSV_PID`; a top-level user shell has no current process, so `proc self` exits"
- docs/reference/cli-commands.md:488 — `GSV_VOICE_DEVICE` — "any active `GSV_VOICE_DEVICE` environment override. That legacy override uses a"
- docs/reference/cli-commands.md:492 — `GSV_VOICE_DEVICE` — "(remove GSV_VOICE_DEVICE)` without echoing the value. A selection of `not"
- docs/reference/cli-commands.md:506 — `GSV_DESKTOP_PATH` — "use the `gsv-desktop` binary. Set `GSV_DESKTOP_PATH` to"
- docs/reference/cli-commands.md:578 — `%ProgramData%\GSV\daemon\logs` — "`%ProgramData%\GSV\daemon\logs`); `logs` tails the latest file with `-l, --lines`"
- docs/reference/cli-commands.md:580 (x2) — `GSV_DEVICE_CONSOLE_FORMAT` — "`GSV_DEVICE_CONSOLE_FORMAT=json` or `GSV_DEVICE_CONSOLE_FORMAT=quiet` to change that."
- docs/reference/cli-commands.md:599 — `%USERPROFILE%\GSV` — "Windows pairing and service installation default to `%USERPROFILE%\GSV`."
- docs/reference/cli-commands.md:623 (x2) — `GSV_GSVD_PATH` — "`GSV_GSVD_PATH` and `PATH` do not override that selection. The CLI checks the"

**docs/reference/configuration.md** — 1 occurrence(s)

- docs/reference/configuration.md:234 — `GSV_PUBLIC_CONFIG` — "Kernel `sys.config` and personal preferences. `GSV_PUBLIC_CONFIG` supplies the"

**docs/reference/syscalls.md** — 4 occurrence(s)

- docs/reference/syscalls.md:256 (x2) — `GSV_INSTALLATION_ID`, `GSV_URL` — "`GSV_INSTALLATION_ID` and its persisted canonical HTTP(S) origin as `GSV_URL`."
- docs/reference/syscalls.md:1724 (x2) — `GSV_MANUAL_BOOTSTRAP_UPSTREAM`, `GSV_MANUAL_BOOTSTRAP_REF` — "\| `sys.bootstrap` \| `handleSysBootstrap` \| Imports `root/gsv-manual`, registers it as a public system repository, and seeds the gateway's bundled skills into the calle..."

#### Bucket B (lowercase `gsv`) — user-readable technical identifiers in prose, links and URLs

- Docs route slug **`/how-to/operate-gsv`**, shown in the URL bar for the page titled "Run Ship for your people" (sidebar "Operate a Ship Deployment"): docs/how-to/index.md:7, docs/how-to/deploy.md:53, :72, docs/how-to/deploy-with-alchemy.md:110, :156, docs/how-to/organisations.md:9, docs/architecture/installation-directory.md:170.
- Visible link text **"github.com/deathbyknowledge/gsv"**: docs/get-started/faq.md:46, :110. Nav-bar "Ship" link target (config.ts:80) and social link (config.ts:212).
- **`gsv.space`** domain: hosted Ship link docs/how-to/deploy-with-alchemy.md:9 ("[hosted Ship](https://gsv.space)"), extension download docs/how-to/connect-devices.md:42 and docs/reference/cli-commands.md:526 (`https://gsv.space/browser`), mail example `<handle>@gsv.space` docs/reference/cli-commands.md:248. Install host is already `install.ship.space` (docs/how-to/install-host-apps.md:26, :33).
- **`gsv` target shown to users**: "The place starts on **your cloud** (`gsv`)." docs/get-started/index.md:158; "the `gsv` target" docs/get-started/faq.md:125; cloud-browsers.md:153, :238, :267, :312, :424; cloud-computers.md:15, :21, :38, :80; connect-devices.md:88. Technical pages: hardware-tools.md (7 target uses, heading "Native `gsv` Target" :208), syscalls.md (6), configuration.md (2), websocket-protocol.md (3), routing.md:50, services.md:17, agent-loop.md:235, architecture/index.md:140, :245, ledger.md:24, targets.md:72.
- **`gsv` CLI in prose/user steps**: connect-devices.md:9, :17, :20 (`gsv pair CODE`); install-host-apps.md:3 ("The operator CLI (`gsv`)"), :10 (table column header `gsv`), :40, :59, :117, :168, :193, :199, :222, :230, :244, :321, :328; get-started/faq.md:125; voice-input.md:128; cli-commands.md (8 command uses + 5 bare); rust-host-applications.md H2 "`gsv`" (:131).
- **`gsvd` daemon**: install-host-apps.md (16, incl. table column :10, `NT SERVICE\gsvd` :150, `%ProgramFiles%\GSV\service\gsvd.exe` :164), rust-host-applications.md (20, H2 "`gsvd`" :48), cli-commands.md (10), security-model.md (2), targets.md (2), cloud-computers.md:96, hardware-tools.md (1).
- **Binaries/artifacts**: `gsv-desktop-windows-x64-setup.exe` (install-host-apps.md:29), `gsv-desktop-darwin-arm64.zip` / `-x64.zip` (:282-283), `gsv-transcribe`, `gsv-speak`, `gsv-transcribe-runtime` (:246-247, :292; voice-input.md:122, :130), `gsv.exe` (:57), `gsv-desktop` binary (rust-host-applications.md:169; cli-commands.md:506), bundle id `space.gsv.desktop` (rust-host-applications.md:170, :382).
- **Paths**: `~/.gsv/bin`, `~/.gsv`, `%LOCALAPPDATA%\Programs\gsv\bin`, `~/.config/fish/conf.d/gsv.fish`, `~/.gsv/logs/auto-update.log` (install-host-apps.md:101-103, :109, :118, :221); `.gsv` folders (faq.md:125; install-host-apps.md:324; context-files.md:158); `/.well-known/gsv/deployment.json` (deploy-with-alchemy.md:46).
- **Repo name `gsv-manual`**: context-and-knowledge.md:95, :112, :113; architecture/index.md:175; r2-storage.md (1); syscalls.md:1724 (2).
- **Operator-visible names**: WhatsApp template `gsv_message` (docs/how-to/messengers.md:148); `GSV_WORKER_PREFIX` default `gsv` (operate-gsv.md:17).
- **Slack `@GSV`** (bucket B, listed above): docs/how-to/messengers.md:70 "Mention `@GSV` in a channel, or send the app a direct message." and :75 "Mention `@GSV` again to start a conversation." The same section calls the app "**Install Ship in Slack**" / "the official Ship app" (:67-68), so the bot's Slack display name is still GSV while the docs name the app Ship.



---

# Surface D: browser extension, messaging adapters, Accounts pages

## 5. GSV traces

Commands (from the worktree root):
```
grep -rnI "GSV" extension workers/adapters workers/installations/src --include='*.ts' --include='*.html' --include='*.json' --include='*.yaml' | grep -v node_modules | grep -v '\.test\.ts' | grep -v '/dist/'
#   → 122 lines raw (incl. test fixtures, worker-configuration.d.ts, imports, env names)
# excluding /test/ and worker-configuration.d.ts, lines / occurrences (grep -o):
#   extension 11 / 11 · workers/adapters 51 / 56 · workers/installations/src 53 / 67
grep -rnI "\bgsv\b" extension/src extension/*.html workers/adapters/*/src workers/installations/src workers/adapters/slack/*.yaml   # lowercase pass
```
Breakdown of non-test hits: extension = 4 HTML titles, 3 comments, 4 `GSVClient` identifiers. Accounts = 1 admin title plus 66 `GSV_*` env names in code. Adapters = 38 user-facing (A below), 7 model-facing (Slack target help), and the rest internal error, comment or env strings.

### A. Brand/product prose or label (would become "Ship")

**Extension (5)**
- extension/panel.html:6 `<title>Your GSV</title>`
- extension/options.html:6 `<title>Your GSV</title>`
- extension/viewer.html:6 `<title>GSV Viewer</title>`
- extension/offscreen.html:5 `<title>GSV Browser Target Recorder</title>` (rarely visible)
- extension/src/panel/panel.ts:412 `${fact("gsv", current.gatewayHost)}`: lowercase in source, rendered "GSV" by `.facts dt { text-transform: uppercase }` (panel.css:115)

**Adapters, end-user messages (Telegram)**
- telegram/src/managed-peer.ts:140 "GSV Telegram could not receive that message type. Please send text or a supported attachment."
- telegram/src/managed-peer.ts:142 "GSV Telegram could not receive that attachment. Please send a smaller file or try again."
- telegram/src/managed-peer.ts:586 "This Telegram connection is still being confirmed in GSV. Finish or retry that confirmation, then send your message again."
- telegram/src/managed-peer.ts:599 "In GSV, open Settings → Messengers → Telegram and paste the code below.\nExpires in 10 minutes."

**WhatsApp**
- whatsapp/src/managed-peer.ts:169 "GSV WhatsApp could not receive that message type. Please send text, a photo, a document, a voice note or a location."
- whatsapp/src/managed-peer.ts:171 "GSV WhatsApp could not receive that attachment. Please send a smaller file or try again."
- whatsapp/src/managed-peer.ts:681 "This WhatsApp connection is still being confirmed in GSV. Finish or retry that confirmation, then send your message again."
- whatsapp/src/managed-peer.ts:690 "In GSV, open Settings → Messengers → WhatsApp and paste the code below.\nExpires in 10 minutes."
- whatsapp/src/managed-peer.ts:961 "An action needs your approval. Open GSV to review it."
- whatsapp/src/whatsapp-template.ts:6 "Your GSV has an update about your request: {{1}} Tap below to continue in WhatsApp." (**Meta-approved template; changing it needs re-approval**)
- whatsapp/src/whatsapp-template.ts:12 "… Open GSV for the full message."
- whatsapp/src/whatsapp-template.ts:27 "You have a new message in GSV."
- whatsapp/src/whatsapp-api.ts:42 "WhatsApp customer service window is closed: this number has not messaged GSV in the last 24 hours" (delivery-failure detail, operator/user-visible where delivery errors show)

**Discord (4 occurrences on 3 lines)**
- discord/src/shared-peer.ts:79 "`${message.text}\n\nOpen your GSV: ${origin}`" (approval prompts)
- discord/src/shared-peer.ts:144 "Connected to your GSV: {origin}"
- discord/src/shared-peer.ts:215 "Connect this Discord identity to your GSV.\n\nPairing code: …\n\nOpen your GSV → Messengers → Discord, enter the code, and confirm the identity shown there. This code expires in 10 minutes." (×2)

**Slack**
- slack/src/managed-peer.ts:877 "This Slack connection is still being confirmed in GSV. Finish or retry that confirmation, then mention GSV again." (×2)
- slack/src/managed-peer.ts:891 "Connect this Slack identity to your GSV."
- slack/src/managed-peer.ts:895 "Open GSV → Messengers → Slack, enter the code, and confirm this identity."
- slack/src/managed.ts:215 "Install GSV using the link, then send link in a direct message to the GSV app to get a pairing code." (×2; shown in the web Messengers UI)
- slack/src/managed-http.ts:182 "Slack installation could not be verified. Start again from GSV."
- slack/src/managed-http.ts:195 "GSV is installed in {team}. You can close this tab and mention @GSV in Slack." (the first GSV is A; "@GSV" is B)
- slack/src/managed-http.ts:200 "Slack installation failed. Please try again from GSV."
- slack/src/managed-http.ts:535 `<h1>GSV for Slack</h1>`
- slack/src/slack-delivery.ts:172 "`*From <@${actorId}>'s GSV:*`" (prefix on every Ship message in shared Slack channels)
- slack/src/slack-api.ts:233 "Invite the GSV app to this Slack conversation before sharing files"
- slack/src/slack-api.ts:236 "Reinstall the GSV Slack app to grant file sharing"
- slack/src/slack-api.ts:239 "The GSV app is not allowed to share files in this Slack conversation"
- slack/slack-app.managed.example.yaml:5 "description: Reach your personal GSV from Slack."

**Adapters, model-facing (count only, per brief):** slack/src/managed-peer.ts:427 target description (×2: "installed GSV app", "that user's GSV"); slack-target-shell.ts:198, 539, 540, 542, 546 (5); slack-target-fs.ts:50 "GSV Slack filesystem" (1). Total 8.

**Adapters, internal errors (likely not end-user, listed for completeness):** slack-api.ts:507 "Slack file exceeds the GSV media limit"; slack-media.ts:49 same; slack-delivery.ts:183 "Slack media attachments must include GSV resource bytes".

**Accounts (1)**
- workers/installations/src/admin/page.ts:19 `<title>${title} · GSV registry</title>` (every admin, operator and bootstrap page)

### B. Technical identifier the user still sees
- workers/adapters/slack/slack-app.managed.example.yaml:4 `name: GSV` and :12 `display_name: GSV`: the Slack app and bot user name, which produces the `@GSV` mention.
- workers/adapters/slack/src/managed-http.ts:195 "mention @GSV in Slack": the bot handle in prose.
- extension/src/panel/panel.ts:346 `placeholder="gsv-pair1_…"`: invitation code prefix shown as the placeholder (the code format itself comes from the protocol package).
- workers/adapters/shared/src/peer-render.ts:117-119: target id `gsv` → "in your cloud home". Other target ids are shown raw ("on {target}").
- `GSVBOT`: only in test fixtures (slack/test/fixture-workers.ts:47-83). Not user-visible.
- `GSV_*` env names: none reach user-visible text on these surfaces. domain.ts:39-117 throws "GSV_BASE_DOMAIN is required/invalid" and "GSV_INSTALLATION_ORIGIN_TEMPLATE is invalid", but admin/http.ts:149 and owner-api.ts:82 forward only messages with whitelisted prefixes, so these become generic errors. email/src/address.ts:32 is a configuration error only.
- Discord gateway IDENTIFY `browser: "gsv", device: "gsv"` (discord-gateway-transport.ts:366-367): bot session properties, not normally shown.
- Internal markers `[gsv-telegram-controls:…]`, `[gsv-whatsapp-controls:…]`, `[gsv-slack-blocks:…]` (telegram managed-peer.ts:929, whatsapp :1111, slack slack-delivery.ts:98) are appended to stored delivery text. They are stripped before send, but could show anywhere stored text is displayed raw.

---



---

# Surface E: CLI, Desktop host, machine daemon

### 5. GSV traces

Commands used (from the worktree root):
- `grep -rnw 'GSV' host/apps --include='*.rs' --include='*.json' --include='*.plist'`: 31 raw hits. 30 are in `.rs`; tests and comments account for 15 of those (control.rs:252-279 ×3, update.rs:1420-1816 ×6, device_service.rs:990,1088, plus comments). 1 hit is in a plist.
- `grep -rnw 'GSV' host/crates --include='*.rs'`: 11 raw hits (2 doc comments, 1 generated doc).
- `grep -rnw 'GSV' host/packaging | grep -v README`: 14 raw hits.
- `grep -rn 'GSV_[A-Z_]*' host/apps --include='*.rs' -o`: 23 distinct env var names.
- `grep -rn 'GSV\.app\|/Applications/GSV'` (excluding docs and web) to find the bundle name.
- For contrast, `grep -rnw 'Ship' host/apps --include='*.rs' | grep -v 'test|assert|//'`: 41.

**A. Brand or product prose and labels (would become "Ship")**
- host/apps/cli/src/cli.rs:34: `Pair this computer with one invitation from GSV (omit it to resume)`
- host/apps/cli/src/cli.rs:98: `Launch, focus, or control the local GSV Desktop application`
- host/apps/desktop/Info.plist:4: `Dictate into GSV using local speech recognition.` (NSMicrophoneUsageDescription)
- host/apps/machine/src/app.rs:11: `about = "GSV machine driver daemon"`
- host/apps/machine/src/app.rs:21: `Gateway URL (overrides local GSV configuration)`
- host/apps/machine/src/app.rs:25: `Gateway username (overrides local GSV configuration)`
- host/apps/machine/src/control.rs:160: `The machine is connected to GSV.`
- host/apps/machine/src/device/mod.rs:1101: `GSV {} is available because {}; waiting for machine work to finish before installing.`
- host/apps/machine/src/device/mod.rs:1229: `Installing GSV {} because {reason}; the service restarts when the installer finishes.`
- host/apps/machine/src/device/mod.rs:1258: `GSV {} is available because {reason}, but automatic updates are off. Run the installer, or set device.auto_update = true.`
- host/apps/machine/src/device/mod.rs:1268: `GSV {} is available, but {error}.`
- host/apps/machine/src/device/mod.rs:1279: `Installing GSV {} because {reason}; the installer started {minutes} minutes ago.`
- host/apps/machine/src/device/mod.rs:1347: `GSV {release} was not installed: the last attempt failed {failed_minutes} minutes ago. The next attempt is due in {due_minutes} minutes.`
- host/apps/machine/src/device/mod.rs:1394: `GSV {release} was not installed: the installer ended without restarting the service ({detail}). See {}.`
- host/apps/machine/src/device/mod.rs:1401: `GSV {release} was not installed ({detail}); a newer handshake has since decided what to do. See {}.`
- host/apps/machine/src/device/mod.rs:1479: `GSV {release} is available, but {error}.`
- host/crates/desktop-protocol/src/error.rs:47: `GSV Desktop is already running` (surfaces through `gsv desktop` commands)
- host/crates/config/src/lib.rs:243: `GSV configuration directory is unavailable`
- host/crates/windows-host/src/security.rs:258: `An administrator must remove the existing untrusted GSV service directory`
- host/packaging/macos/Info.plist:8,18: CFBundleDisplayName / CFBundleName `GSV`. Masked by en.lproj "Ship", but it is the fallback for any locale without its own lproj.
- host/packaging/windows/uninstall.ps1:4: `Uninstall the daemon service as its enrolling user before removing GSV`
- host/packaging/windows/uninstall.ps1:7: `Close GSV Desktop and its helpers before uninstalling`
- host/packaging/windows/gsv.nsi:70: `Stop and uninstall the GSV service as its enrolling user before removing the applications.`
- host/packaging/windows/gsv.nsi:17: `"LegalCopyright" "GSV contributors"` (file properties)
- Contrast: the CLI release hint already says "Ship {} is available; this CLI is {current}." (commands/chat.rs:846), while gsvd's equivalent notices still say "GSV {} is available…".

**B. Technical identifiers the user still sees**
- Env vars in help (`[env: …]` shown by clap): `GSV_URL`, `GSV_TOKEN` (cli.rs:13,25); `GSV_URL`, `GSV_USER`, `GSV_TOKEN` (machine/src/app.rs:22,26,29).
- Env vars in error and output text: `GSV_GSVD_PATH` (cli/src/device_service.rs:86), `GSV_DESKTOP_PATH` (cli/src/desktop.rs:206), `GSV_VOICE_DEVICE` (desktop.rs:387), `GSV_INSTANCE_SECRET` (machine/src/app.rs:182). Update commands printed to the user embed `GSV_VERSION=` and `GSV_INSTALL_DIR=` (crates/config/src/installer.rs:38-48, shown via chat.rs:846 and update.rs `Run the installer yourself: {command}`).
- `GSV.app`: bundle name on disk (cli/src/desktop.rs:213; host/scripts/package-macos.sh:103,162; README says it stays `GSV.app` on purpose, host/packaging/macos/README.md:5).
- `/Applications/GSV/…`: test fixtures only (device_service.rs:990,1088).
- `gsvd`: daemon binary, systemd unit `gsvd.service`, launchd label `gsvd`, Windows service name `gsvd` and account `NT SERVICE\gsvd` (device_service.rs:16-18; crates/windows-host/src/service.rs:12-13). Named in roughly 40 help and output lines ("the local gsvd service", "gsvd runtime:", "gsvd installed and started.").
- `gsv-desktop`, `gsv-desktop.exe` executable names (desktop.rs:179-181,206), `gsv.exe` and `gsvd.exe` (windows_service.rs:271-348).
- Folders: Windows `%ProgramData%\GSV\…`, `%ProgramFiles%\GSV\service` (crates/windows-host/src/service.rs:49-61), shown in "Service removed. Enrollment and workspace remain at {}" (windows_service.rs:142); default Windows workspace `~/GSV` (crates/config/src/lib.rs:25); `~/.gsv` (config/src/lib.rs:15-19); registry key `…\Uninstall\GSV` (gsv.nsi:10,60-63); old shortcut `GSV.lnk` deleted (install.ps1:394).
- Pairing code prefix `gsv-pair1_` (pairing.rs:90) and credential prefix `gsv_machine_` (pairing.rs:238), visible in the pasted invitation string.
- Login token label `gsv-cli@{os}` (auth_flow.rs:171), visible in token lists.
- Bundle identifier `space.gsv.desktop` (tauri.conf.json:5; packaging Info.plist:14), visible in macOS privacy settings and the Wayland portal.
- Shell prompt `gsv$ ` (cli/src/device/mod.rs:350).
- The `gsv` command name in prose ("run `gsv auth login`", "gsv pair CODE", "gsv daemon install"): contractual, listed only for completeness (cli.rs:78; pairing.rs:197,230,254,287,291,350; device/mod.rs:192-193).

---



---

# Surface F: prompts, skills, man pages

Path abbreviations in this section: `P/` = `workers/gateway/src/prompts/`, `MAN` = `workers/gateway/src/drivers/native/man-pages.ts`, `SYS/` = `workers/gateway/src/syscalls/`, `LC` = `workers/gateway/src/process/internal/lifecycle.ts`, `SCH` = `workers/gateway/src/process/internal/schemas.ts`.

## 5. GSV traces

Commands (from the worktree root; F = every file in scope, listed in the preamble plus SYS/index.ts, LC, SCH):
- `grep -c 'GSV' $F` → per-file counts; `cat $F | grep -o 'GSV' | wc -l` → **74** "GSV" occurrences (includes 69 lines, after excluding `@humansandmachines/gsv` imports).
- `cat $F | grep -ow 'gsv' | wc -l` → **84** whole-word lowercase "gsv" (mostly the `gsv` target, `gsv-manual`, `gsv:/path`, package imports).
- `cat $F | grep -o 'Ship' | wc -l` → **47** "Ship".
- Per-file "GSV" counts: MAN 22; skills/browser-target 8; workers/gateway/src/kernel/sys/manual.ts 8 (all identifiers); P/context-origin.ts 6; skills/skill-authoring 3; P/system/context.d/01-gsv.md 2; P/system/context.d/05-targets.md 2; skills/image-reading 2; skills/process-orchestration 2; P/agent-home.ts 2; SCH 2; LC 2; and 1 each in 02-interaction.md, ship/00-role.md, tasks/compaction.md, tasks/setup-assist.md, P/personal-intelligence.ts, builtin-skills.ts, SYS/shell.ts, SYS/index.ts (comment).
- Man-page "Ship" count: 13 (MAN:10-39, 260, 289, 300, 525, 527). Man-page "GSV": 22.

### A. Brand/product prose or label (would become "Ship" or a plain noun)

`A*` = covered by the 01-gsv.md:9 rule as "runtime" usage. Flag it for a decision; don't change it by default.

- P/system/context.d/01-gsv.md:3 (A*) — "You are an agent aboard the user's Ship, powered by the GSV runtime: a persistent, Linux-like computer. … GSV and connected machines, browsers, and services are available as named targets."
- P/system/context.d/01-gsv.md:9 (A*, the rule itself) — "Ship is the product name. GSV remains the technical name for the runtime, the `gsv` target and command, protocol identifiers, and `.gsv` paths."
- P/system/context.d/02-interaction.md:3 — "You receive messages from people, other agents, and GSV itself."
- P/system/context.d/05-targets.md:3 — "Run GSV management commands on `gsv`; there, `~` is your agent home."
- P/system/context.d/05-targets.md:14 — "Save needed files to GSV before a temporary computer stops."
- P/ship/context.d/00-role.md:7 — "GSV is your persistent home for files, knowledge, tools and ongoing work."
- P/tasks/compaction.md:1 — "Write a concise handover for a continuing GSV process."
- P/tasks/setup-assist.md:1 — "You are GSV's first-boot onboarding guide."
- P/context-origin.ts:7 — `description: "this GSV process"`
- P/context-origin.ts:37 — `description: "this GSV client"`
- P/context-origin.ts:43 — `description: "the calling GSV process"`
- P/context-origin.ts:49 — `description: "this GSV device client"`
- P/context-origin.ts:91 — `return "GSV Web Desktop";`
- P/context-origin.ts:115 — `["gsv", "GSV"],` (adapter display-name casing; gives "this GSV …" for a `gsv` adapter)
- P/personal-intelligence.ts:14 (retired seed) — "Remove an entry only after GSV has closed the user-facing loop"
- P/agent-home.ts:6 (retired seed) — "This GSV was just created. Treat this as a one-time onboarding assignment."
- P/agent-home.ts:9 (retired seed) — "Help the user and your own agent account finish setting up GSV: …"
- skills/browser-target/SKILL.md:3 — "description: Use GSV's browser capability for public websites and signed-in web apps, …"
- skills/browser-target/SKILL.md:12 — "GSV capability: use a suitable existing browser or provision a cloud browser."
- skills/browser-target/SKILL.md:47 — "Browser use is a built-in GSV capability with two providers: …"
- skills/browser-target/SKILL.md:143 — "Run target-qualified `cp` from the native GSV shell or target-aware filesystem"
- skills/browser-target/SKILL.md:300 — "target from the native GSV shell, then run `tabs open` on the browser-local"
- skills/browser-target/SKILL.md:325 — "are the target filesystem exposed through GSV."
- skills/browser-target/SKILL.md:365 — "ask the person to focus that tab, open Your GSV from the toolbar, and choose" (stale UI name; extension says "Your Ship")
- skills/browser-target/SKILL.md:369 — "to another target, copy it from the native GSV shell after recording stops."
- skills/image-reading/SKILL.md:3 — "description: Read and analyze images on GSV or connected targets with img2txt. …"
- skills/image-reading/SKILL.md:20 — "be copied into GSV first."
- skills/process-orchestration/SKILL.md:3 — "description: Choose and use GSV delegation, subprocess, IPC, scheduling, and cron workflows. …"
- skills/process-orchestration/SKILL.md:65 — "Otherwise, the answer remains in the GSV process conversation."
- skills/skill-authoring/SKILL.md:3 — "description: Create or revise reusable GSV agent workflows under skills.d. …"
- skills/skill-authoring/SKILL.md:6 — "# Author GSV Skills"
- skills/skill-authoring/SKILL.md:20 — "non-obvious steps, exact GSV commands, decision points, validation, and common"
- workers/gateway/src/kernel/sys/builtin-skills.ts:12 (legacy upgrade match) — "description: Store, retrieve, and organize GSV agent memory. …"
- MAN:178 — "  kernel   Native GSV capability environment."
- MAN:252 — "  the linked actor addresses GSV on that exact surface. Destination ids are"
- MAN:253 — "  opaque GSV references; copy one from this list instead of using provider ids."
- MAN:277 — "  Repeat --attach to stream multiple GSV filesystem files in one delivery."
- MAN:279 — "  connected-machine file to GSV before attaching it."
- MAN:282 — "  `message attach` adds one or more GSV filesystem files to this run's next"
- MAN:297 — "  A Contact send reports accepted once GSV durably owns it; this is distinct"
- MAN:335 — "  Finish the current human-facing run and return control to GSV. The durable"
- MAN:350 — "  cp - copy one file locally or between GSV targets"
- MAN:396 — "  The address is this GSV's own mailbox, kept for the owner's convenience:"
- MAN:402 — "  A successful command normally reports queued after GSV durably owns Queue"
- MAN:415 — "  mail send --to person@example.com --subject 'Hello' --message 'Hello from GSV'" (sample the agent may copy into real outbound mail)
- MAN:500 — "      Print the current GSV process id. This requires a process-backed shell;"
- MAN:588 — "  codemode - run JavaScript blocks with GSV shell and filesystem wrappers"
- MAN:632/635/638 (A*) — "GSV(1)" / "  gsv - distributed AI operating environment" / "  GSV gives AI processes explicit tools and Unix-shaped capability environments called targets."
- MAN:782 — "      Refresh the built-in GSV Manual from its configured upstream."
- MAN:790 — "  GSV provisions the `personal` wiki; do not create an agent-local substitute."
- SYS/shell.ts:7 — "… search the live GSV capability manual on target \"gsv\" with `man --search -- '<plain-language goal>'` …"
- SCH:29 — "description: `Run a GSV shell command. ${RUN_CONTROL_INSTRUCTION}`"
- SCH:35 — "description: \"The message or run-control command to run on GSV.\""
- LC:141 — "A runtime event arrived while you were busy. Review the GSV event above and continue."
- AGENTS.md:270 (contract, cross-ref) — "… and the GSV Manual (`deathbyknowledge/gsv-manual`, which every installation imports for its agents) …"

### B. Technical identifier the user may still see

- workers/gateway/src/process/history/model-renderer.ts:169 / P/system/context.d/02-interaction.md:3 — `[GSV EVENT]` marker ("`[GSV EVENT]` marks a system update."); model may quote it.
- `gsv` target as an id the agent names: 05-targets.md:3, :13; 20-discovery.md:3; 30-process-orchestration.md:3; tasks/memory-review.md:3; welcome.md:91 ("when the `gsv` target implements `web.search`"), welcome.md:93 ("their home on the `gsv` target"); SYS/index.ts:51 ("Use \"gsv\" for the native cloud target"); SYS/index.ts:84; SYS/search.ts:7 ("sources on gsv"); SYS/shell.ts:7 (target "gsv"); SYS/codemode.ts:7 ("defaults to gsv"); skills/browser-target/SKILL.md:21, :25, :27, :40, :58, :68; skills/image-reading/SKILL.md:8; skills/process-orchestration/SKILL.md:8; MAN:356 ("`gsv:/path` names the cloud filesystem"), MAN:373, MAN:639, MAN:805, MAN:810; LC:48 (`target: "gsv"`).
- `gsv-manual` id: welcome.md:43 ("read gsv-manual"), welcome.md:90; skills/gsv-manual/SKILL.md:2, :15, :21, :27; MAN:781 ("wiki refresh gsv-manual"); workers/gateway/src/kernel/sys/manual.ts:10, :39, :96, :100, :106 (`root/gsv-manual`).
- `GSV_*`: `GSV_MESSAGE` heredoc delimiter the agent writes in Shell (LC:109; MAN:269, :309, :311); `$GSV_PID` (MAN:501); `GSV_MANUAL_BOOTSTRAP_UPSTREAM` / `GSV_MANUAL_BOOTSTRAP_REF` (workers/gateway/src/kernel/sys/manual.ts:8-9, operator env, not model-facing).
- `gsv` man page name and command: MAN:630 (`case "gsv"`), MAN:632 "GSV(1)" → `man gsv`.
- `gsv-ui` client id driving the "GSV Web Desktop" label (P/context-origin.ts:90).
- Commit authors/messages in the user's home repos: `${username}@gsv.local`, "gsv: seed built-in skills" (workers/gateway/src/kernel/sys/skills-seed.ts:77-78); `root@gsv.local`, "gsv: update manual" (workers/gateway/src/kernel/sys/manual.ts:92-93). These show in `rgit log` and any repo history UI.
- Example paths `~/projects/gsv` (MAN:626) and `gsv:/home/alice/projects/gsv/...` (MAN:805, :810); `'{"query":"gsv"}'` (MAN:222).

