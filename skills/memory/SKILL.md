---
name: memory
description: Retrieve and maintain the memory. Use when you need to remember something. personal history, preferences, people, projects, decisions, routines, places, or prior events or when the user asks to remember something.
---

# Manage Personal Memory

Memory belongs to the human, not to an individual agent. Every agent working for the same user reads and writes the same two layers:

- The `personal` wiki contains durable information that is searched and loaded when relevant.
- The owner's `context.d/10-personal.md` contains a very small set of stable facts and preferences that should affect nearly every interaction. It appears under the editable `<user>` context root in the prompt; do not confuse it with the current agent's `~/context.d/`.

The personal intelligence's account-local commitments file is working state, not personal memory. Do not copy open tasks into the wiki merely because they exist. Record an outcome later only when it is useful history.

## Decide When to Read

Retrieve memory before asking, recommending, or acting when the correct interpretation or outcome could depend on personal history that is not already in the current context. Examples include an ambiguous person or project name, the user's usual grocery order, travel details, prior decisions, recurring preferences, and where the user normally keeps something.

Do not search memory for self-contained questions whose answer cannot depend on the user. Do not search merely to prove that memory exists.

Search narrowly before opening broad pages:

```bash
wiki search <query> --prefix personal
```

Use `wiki info personal` when the page location is unknown. Once a relevant page is known, use normal filesystem tools to read its Markdown under the path reported by `wiki info`.

## Decide When to Write

Write immediately when the user explicitly says to remember an unambiguous fact or corrects an existing fact. Also write a concrete, stable fact or preference that the user states explicitly when it will improve future help.

Search and merge before writing when the fact may already exist, refers to an ambiguous person or project, supersedes older information, or belongs on more than one existing page. In a direct user interaction, the personal intelligence should delegate this investigative memory work; a worker already assigned the work may perform it directly.

Append a journal entry for a meaningful event or outcome whose chronology may matter later. Use ISO dates:

```bash
pages/journal/YYYY/MM/YYYY-MM-DD.md
```

## Organize the Wiki

Search before adding duplicate information. Read a page before editing it. Keep `index.md` as an orientation page and use `inbox/` only for information that genuinely cannot yet be placed. Promote durable information into topical pages such as:

- `pages/people/`
- `pages/projects/`
- `pages/preferences/`
- `pages/decisions/`
- `pages/routines/`
- `pages/places/`
- `pages/concepts/`

When a name is ambiguous, make the short-name page a disambiguation page that points to specific pages. Replace superseded facts rather than accumulating contradictions. Prefer concise facts and useful context over prose about the act of remembering.

Use `man wiki` for exact wiki syntax and general wiki workflows.

## Maintain Standing Memory

Edit the owner's `context.d/10-personal.md` only for explicit, stable facts or preferences that should be present in almost every interaction. Keep the file small, preserve its purpose statement, and replace corrected facts.

Open commitments remain with the personal intelligence until the user-facing loop closes.
