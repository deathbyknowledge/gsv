# Resource References and Lazy Binary Resolution

Status: deferred design proposal. This is not the current runtime contract.

GSV should represent files and media once, as authorized resource references,
and move their bytes only when a consumer resolves those references. Structured
protocol frames remain the control plane. The existing binary-body channel
remains the data plane.

This avoids turning an image into bytes, then base64, then bytes again; avoids
copying the same attachment at every process, adapter, and client boundary; and
lets Web, Desktop, models, and other clients resolve the same resource lazily.

## Proposed contract

A message or tool result contains a typed resource block rather than inline
bytes or separate process-media metadata:

```ts
type FileRef = {
  type: "file";
  target: string;
  path: string;
  revision: string;
  contentType: string;
  size: number;
  expiresAt?: number;
};

type ResourceBlock = {
  type: "resource";
  ref: FileRef;
};
```

The final shape may use an opaque Kernel-issued identifier instead of exposing
every locator field. The invariant is more important than the encoding: a
reference identifies one authorized, immutable resource version and carries no
bytes.

## Resolution flow

```text
machine, browser, adapter, or gsv produces a file
  -> the owning boundary returns an authorized immutable reference
  -> a message or tool result persists that reference once
  -> a model or client resolves it when needed
  -> fs.transfer.send returns the bytes over the binary-body channel
  -> GSV may retain one durable, content-addressed copy when history requires it
```

Base64 is permitted only at the final provider adapter when a model API requires
that representation. It must not be the GSV transport, history, or storage
format.

`fs.transfer.stat`, `fs.transfer.send`, `fs.transfer.receive`, `fs.copy`, and the
binary-body channel already provide most of the required data plane. The new
work is primarily a common reference type, authorization and lifetime rules,
message content support, and resolvers for models and clients.

## Required invariants

- A raw `{ target, path }` supplied by untrusted content is not automatically an
  authorized reference. Issuance or admission checks the originating identity
  and records provenance so automatic hydration cannot become a confused-deputy
  file read.
- A durable reference identifies immutable content. Mutable device nodes such as
  a camera snapshot must mint a unique snapshot path or strong revision before
  returning a reference.
- Resolution rechecks target ownership and current authorization. Provider URLs,
  credentials, and installation identifiers do not become public reference
  material.
- The resolver owns the binary body until it is consumed, forwarded, or
  cancelled. Disconnects and partial reads have one cleanup path.
- Temporary references expose expiry and offline behavior. A missing source is a
  visible unavailable-resource result, never silent substitution with newer
  bytes.
- Content needed for durable process history is retained once in GSV, preferably
  as a read-through, content-addressed copy. History then points at the retained
  revision without duplicating the bytes.
- Models and visual clients consume the same reference. Provider-specific image
  blocks and UI object URLs are projections created only at their final boundary.

## Relationship to process media

`proc.media.*` currently supplies process ownership, idempotent uploads,
rollback, R2 storage, history references, and archive promotion. Those
properties must survive the migration, but clients should not have to
orchestrate that storage protocol.

During transition, process media can remain the internal retention/cache
implementation behind a resource resolver. The intended end state is:

- message and tool-result contracts carry resource blocks;
- clients upload or serve files through target filesystem transfer primitives;
- lazy reads use binary bodies;
- durable retention is automatic policy at the Process boundary; and
- public `proc.media.write/read/delete` calls can be retired once all producers
  use the common reference contract.

The current tool-result bridge accepts inline provider image blocks, extracts
their bytes into process-scoped R2 media, persists only references in new
history, and rehydrates bytes while assembling model context. The common
reference migration must replace that initial inline/base64 boundary rather
than layering another copy on top. It must also continue resolving existing
tool-result media references and legacy inline history until an explicit data
migration or compatibility cutover retires both representations.

## Suggested implementation order

1. Define and validate the reference and resource-block protocol types.
2. Let image-bearing `fs.read` tool results persist a source reference without
   materializing base64.
3. Add one Process resolver that streams a reference through
   `fs.transfer.send`, retains it when required, and projects it into provider
   image content only while assembling model context.
4. Let Web and Desktop resolve the same reference lazily and cache by revision.
5. Move client uploads and adapter media onto references while preserving their
   current authorization and replay fences.
6. Remove the superseded public process-media orchestration after a deliberate
   compatibility cutover.

Before implementation, decide the reference issuer/authorization encoding,
retention point, source expiry contract, and whether cross-target references are
structured or Kernel-opaque.
