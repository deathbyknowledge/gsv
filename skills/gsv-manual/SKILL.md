---
name: gsv-manual
description: Route GSV operating-model and user-facing questions to the repo-backed GSV Manual through the wiki CLI.
---

# GSV Manual

Use this skill when answering questions about how GSV works, how users should operate it, or which product/runtime surface owns a workflow.

Prefer the repo-backed manual for operating-model and user-facing answers. Use repository source only when you are changing code, debugging implementation behavior, or the manual is missing or contradicted by current source.

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

Keep answers grounded in the retrieved manual pages. Do not recreate the manual taxonomy inside this skill.
