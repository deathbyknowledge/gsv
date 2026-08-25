# Identity Disc Files

An Identity Disc is a lightweight `.idz` file for durable process memory. It is
not a transcript and not a hidden vector store. It is a human-editable index of
facts, decisions, preferences, procedures, open loops, and source references
that future processes should be able to discover quickly.

## Locations

Use these conventional paths:

```text
~/identity.idz
/workspaces/{workspaceId}/.gsv/identity.idz
```

`~/identity.idz` is user-global. Workspace discs are task-local and should not
carry unrelated user preferences or global operating policy.

The process prompt advertises only each disc's summaries and compact entry
index. Full entry bodies stay in the `.idz` file and should be read explicitly
with normal file tools.

## Format

The format is line-oriented and grep-friendly:

```idz
# idz/v1
@disc title="Root Identity Disc" owner="root" updated="2026-05-25T10:00:00.000Z"
@summary "Package authoring memory belongs in a compact searchable disc index."

@entry id="pkg-sdk" kind="decision" scope="home" summary="Prefer @gsv/package helpers for reusable package memory." tags="packages,sdk" confidence="high" updated="2026-05-25T10:00:00.000Z"
Use `@gsv/package/identity-disc` when a package needs to read or write `.idz`
files from a backend, CLI command, or browser app.

@entry id="runtime-disc-provider" kind="fact" scope="workspace" summary="The runtime advertises .idz summaries and indexes, not full bodies." tags="runtime,context"
Full details should be retrieved by reading the `.idz` file.
```

Directives:

- `# idz/v1` identifies the file version.
- `@disc` sets optional file metadata.
- `@summary` adds a prompt-visible summary line.
- `@entry` starts a record. Body text continues until the next `@entry`.

Standard entry attributes:

| Attribute | Meaning |
|---|---|
| `id` | Stable entry id. |
| `kind` | `fact`, `preference`, `decision`, `procedure`, `source`, `todo`, `event`, or `note`. |
| `scope` | `home`, `workspace`, `package`, `process`, `target`, or `system`. |
| `summary` | Compact prompt-visible description. |
| `tags` | Comma-separated index tags. |
| `confidence` | `low`, `medium`, `high`, or `verified`. |
| `source` | Inspectable file, URL, process, or command reference. |
| `created` / `updated` | ISO timestamps. |

Unknown attributes are allowed and should be preserved by tools when possible.

## SDK Helpers

Package code can import helpers from `@gsv/package/identity-disc`:

```ts
import {
  parseIdentityDisc,
  renderIdentityDiscContext,
  serializeIdentityDisc,
  upsertIdentityDiscEntry,
} from "@gsv/package/identity-disc";

const disc = parseIdentityDisc(text);
const next = upsertIdentityDiscEntry(disc, {
  id: "package-review-policy",
  kind: "procedure",
  scope: "workspace",
  summary: "Run package reviews against source and requested capabilities.",
  tags: ["packages", "review"],
});

await ctx.kernel.request("fs.write", {
  target: "gsv",
  path: "/workspaces/ws/.gsv/identity.idz",
  content: serializeIdentityDisc(next),
});

const promptPreview = renderIdentityDiscContext(next, { maxEntries: 8 });
```

Use the SDK in package CLIs, backends, or apps when a package owns a memory
workflow. Processes can also edit `.idz` files directly with ordinary shell and
filesystem tools.

## What Belongs Elsewhere

Use `.idz` for compact durable memory and references. Do not use it for:

- long source material, which belongs in `~/knowledge/`, workspace files, or package docs
- reusable workflows, which belong in `skills.d`
- always-relevant instructions, which belong in `~/context.d` or profile context
- raw logs or full chat transcripts, which belong in process archives or workspace artifacts
