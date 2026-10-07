import browserTargetSkill from "../../../../../skills/browser-target/SKILL.md";
import gsvManualSkill from "../../../../../skills/gsv-manual/SKILL.md";
import imageReadingSkill from "../../../../../skills/image-reading/SKILL.md";
import memorySkill from "../../../../../skills/memory/SKILL.md";
import processOrchestrationSkill from "../../../../../skills/process-orchestration/SKILL.md";
import skillAuthoringSkill from "../../../../../skills/skill-authoring/SKILL.md";

// Used only to upgrade the untouched generated memory skill from the
// per-agent wiki model to the human-owned Personal wiki model.
export const LEGACY_MEMORY_SKILL = `---
name: memory
description: Store, retrieve, and organize GSV agent memory. Use for durable facts, preferences, decisions, journal notes, project background, or active commitments that may need standing context.
---

# Manage Memory

Choose the memory layer according to how the information must be retrieved:

- Use the \`memory\` wiki for durable, searchable information that can be loaded when needed.
- Use \`~/context.d/\` only for compact information that must appear in every prompt.

## Use the Memory Wiki

Run wiki commands through \`Shell\` on target \`gsv\`. Inspect the conventional per-agent wiki first:

\`\`\`bash
wiki info memory
\`\`\`

If it does not exist, create it:

\`\`\`bash
wiki db init memory --title "Agent Memory"
\`\`\`

Use \`wiki info memory\` to inspect its page tree and backing repo path. Search before adding duplicate information:

\`\`\`bash
wiki search <query> --prefix memory
\`\`\`

Once the relevant page is known, use normal filesystem tools to read and edit its Markdown files. Keep \`index.md\` as an orientation page. Use dated journal pages under \`pages/journal/YYYY/MM/YYYY-MM-DD.md\` for chronological observations, and promote stable information into topical pages such as:

- \`pages/people/\`
- \`pages/projects/\`
- \`pages/preferences/\`
- \`pages/decisions/\`

Read a page before editing it. Store concise facts and useful context rather than raw transcripts. Do not store secrets, credentials, tokens, or unnecessary private data.

Use \`man wiki\` for exact wiki syntax and general wiki workflows.

## Use Standing Memory

Files under \`~/context.d/\` are loaded into every prompt. Create or edit one only when retrieval on demand is not sufficient.

For active commitments, unresolved questions, blockers, or follow-ups that must remain visible, create a short \`~/context.d/20-open-loops.md\`. Remove resolved items promptly. Delete the file when no active item still requires standing visibility, moving useful history or evidence to the \`memory\` wiki first.

Preserve user-written standing context and keep the total standing context small.
`;

export const BUILTIN_SKILL_FILES = [
  {
    path: "browser-target/SKILL.md",
    content: browserTargetSkill,
    previousSha256s: [
      // Every untouched browser-target skill revision shipped before the
      // signed-in reach guidance, oldest first (commit on main).
      "fa5f18130664bcb6019961aa3d936f16d81c518bc08f7ad17aeb3117b8626d34", // daca691f2
      "5060094769ea048212d968e3fb56123f376dca0a9f22e6dee2e84b8fe980524a", // 2828350db
      "523aff049f7b9fe5de7f45df0aefaecb7ae2a740f64359e39f538a5dd7b4509c", // 6e207c701
      "9ceec71863f092e24a59e4ece199c6848fd7704798bcc6d3b2d5b64a74730a7f", // 4a7a8b05b
      "5a56d71191e09e83ec08a220a556e2f0cc8d667cb4c378a640826a2f7b2e66fb", // 72c85896d
      "ca2db6a7ac6b009e0c2e7d05080d280b311c3b8d7dca3e157c118cd0109f4f41", // ec3d0ce4c
      "987f00c42200eff78671bcb0266e764bc83e28faf632f5d3f314e3fbb946a516", // 63bd5fa7a
      "d0d9a6aa62fa95f0966965be8641920c3fdd82025f9c2d9ae353936773bcbb06", // d315f6967
      "5f3f4d73656a79e7a304f583571068497ffa62309c2aae750ad2529589414feb", // 174351779
      "0b7f67fbf30c0b1f22d57cda25678bcbd78d4c15cd052f0b59815e6ec09f496e", // eed4685c0
      "14a49e723679cbb145170c6888f117dfd53dc25a37ed7c38683ad5a0d2933f56", // eedc54d1d
      // Untouched skill before verified forms and compact action snapshots.
      "9ab07b08b827a4584cfac451f8c635d45d50f3ad71b14e7d73321f5fc79d276c",
    ],
  },
  {
    path: "gsv-manual/SKILL.md",
    content: gsvManualSkill,
    previousSha256s: [
      // Every untouched manual skill revision shipped before the
      // consult-before-refusing guidance, oldest first (commit on main).
      "c1a11191d4be6e4ea02bdd083774a64a34ccf441197217a46c013da6054e41e9", // 8f320d64d
      "5813fb7fac8a490befe23d6bd8bc989e1c04596ef9e3f6e489517d95b3102a33", // ce3f337ec
      "ea066cdfef003f95cb6e305e0b407d24afd6f5ce8534c6a7f0a9c892446d7199", // 1cc4db350
      "d3ee5f1b99eb6a9a8853d65fc24869f844699aa9d717c161abcaac55a166d6c2", // 713d4180a
      "030dbc4de9d9672f08ea0a54bf02d175906a8594eba6fe65329a71c28141315d", // 8e073726e
    ],
  },
  {
    path: "image-reading/SKILL.md",
    content: imageReadingSkill,
  },
  {
    path: "memory/SKILL.md",
    content: memorySkill,
    previousContents: [LEGACY_MEMORY_SKILL],
    previousSha256s: [
      // Exact untouched human-owned memory skill shipped before the r12y ledger.
      "32be7b318bfcc8e09a0d14c4f4853b6d8cc7e5e170f48e653a7e4b9514e77e25",
      // Exact untouched Personal wiki skill shipped before archive recovery guidance.
      "2da2c30829f569a94e698f0e1eb6b0fe4d471dd99904b44825406495a5cd598a",
    ],
  },
  {
    path: "process-orchestration/SKILL.md",
    content: processOrchestrationSkill,
  },
  {
    path: "skill-authoring/SKILL.md",
    content: skillAuthoringSkill,
  },
] as const;
