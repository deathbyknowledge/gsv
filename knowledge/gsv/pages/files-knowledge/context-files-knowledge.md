# Context, Files & Knowledge Boundaries

[Files & Knowledge](index.md)

GSV gives agents several ways to use information. Choosing the right place keeps agents useful and keeps the user's computer understandable.

## Use Context For Standing Behavior

Context is loaded into an agent's working prompt. It should be short and stable.

Good context examples:

- "Prefer concise status updates."
- "Use this account for package reviews."
- "This project uses TypeScript with double quotes."
- "Ask before sending external messages."

Poor context examples:

- A full API manual.
- Raw logs.
- An entire source tree.
- Temporary task notes.

Large or changing material belongs in Wiki or Files.

## Use Wiki For Reference Knowledge

Wiki is durable and searchable. Use it for procedures, explanations, design notes, source references, summaries of imported material, and knowledge bases an agent should consult when relevant.

Wiki should not replace a project directory. If the thing is a build artifact, code file, CSV, archive, or user document, keep it as a file and link to it from Wiki when useful.

## Use Files For Artifacts

Files are the right place for anything the user may open directly, edit with tools, copy across targets, or use outside a knowledge workflow.

Examples:

- Reports and exports.
- Project source.
- Configuration files.
- Images, recordings, and attachments.
- Data files.

## Use Conversations For Work In Progress

Conversation history is useful for review and continuity, but it is not the best storage location for finished facts or deliverables. When a task finishes, agents should point to the durable artifact.

## For Agents

If you need information later, place it somewhere visible and linkable. If you are unsure where it belongs, ask the user: "Should I save this as a file, a Wiki note, or standing agent context?"
