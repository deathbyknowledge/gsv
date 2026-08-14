import browserTargetSkill from "../../../../skills/browser-target/SKILL.md";
import gsvManualSkill from "../../../../skills/gsv-manual/SKILL.md";
import imageReadingSkill from "../../../../skills/image-reading/SKILL.md";
import memorySkill from "../../../../skills/memory/SKILL.md";
import processOrchestrationSkill from "../../../../skills/process-orchestration/SKILL.md";
import skillAuthoringSkill from "../../../../skills/skill-authoring/SKILL.md";

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
  },
  {
    path: "gsv-manual/SKILL.md",
    content: gsvManualSkill,
  },
  {
    path: "image-reading/SKILL.md",
    content: imageReadingSkill,
  },
  {
    path: "memory/SKILL.md",
    content: memorySkill,
    previousContents: [LEGACY_MEMORY_SKILL],
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
