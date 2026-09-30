---
name: gsv-manual
description: Consult the GSV Manual before saying GSV cannot do something, and for questions about its operating model, workflows, settings, devices, agents, automation, integrations, filesystem, desktop, shell and media commands.
---

# GSV Manual

Use this skill when answering questions about how GSV works, how users should operate it, or where to do things, and before telling the user that GSV cannot do something.

Prefer the GSV Manual wiki for operating-model and user-facing answers. Use repository source only when you are changing code, debugging implementation behavior, or the manual is missing or contradicted by current source.

Start with the manual overview:

```bash
wiki info gsv-manual
```

Read the page that matches the task:

```bash
wiki read gsv-manual/pages/<page>.md
```

Search when the page path is not obvious:

```bash
wiki search <query> --prefix gsv-manual
```

Keep answers grounded in the retrieved manual pages.
