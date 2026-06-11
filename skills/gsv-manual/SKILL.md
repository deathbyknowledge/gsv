---
name: gsv-manual
description: Use the GSV Manual for questions about GSV's operating model, user workflows, settings, devices, users and agents, packages, automation, integrations, filesystem, desktop, updates, and source/debug orientation.
---

# GSV Manual

Use this skill when answering questions about how GSV works, how users should operate it, or where to do things.

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
