# Resource References and Lazy Binary Resolution

Status: implemented. Messages, Process output, adapters, Web, and Desktop use
the common reference contract. Public process-media orchestration has been
removed; legacy stored descriptors remain readable.

GSV should represent files and media once, as authorized resource references,
and move their bytes only when a consumer resolves those references. Structured
protocol frames remain the control plane. The existing binary-body channel
remains the data plane.

This avoids turning an image into bytes, then base64, then bytes again; avoids
copying the same attachment at every process, adapter, and client boundary; and
lets Web, Desktop, models, and other clients resolve the same resource lazily.

## Contract

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
  mediaType?: "image" | "audio" | "video" | "document";
  filename?: string;
  duration?: number;
  transcription?: string;
};
```

The locator is not a bearer capability. Issuance validates the source, and
resolution repeats normal target, path, identity, and capability checks. A
reference identifies one immutable resource version and carries no bytes.

## Resolution flow

```text
machine, browser, adapter, or gsv produces a file
  -> the owning boundary returns an authorized immutable reference
  -> a message or tool result persists that reference once
  -> a model or client resolves it when needed
  -> fs.transfer.send returns the bytes over the binary-body channel
  -> Process retains one durable immutable copy when history requires it
```

Base64 is permitted only at the final provider adapter when a model API requires
that representation. It must not be the GSV transport, history, or storage
format.

`fs.transfer.stat`, `fs.transfer.send`, `fs.transfer.receive`, `fs.copy`, and the
binary-body channel provide the data plane. WebSocket framing and Worker RPC
use byte-oriented `ReadableStream` values with backpressure. Metadata crosses
in the structured frame; bytes are never serialized into the RPC argument.

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
- Content needed for durable process or conversation history is retained once
  in the run-as agent's immutable archive. History then points at that retained
  revision without duplicating the bytes.
- Models and visual clients consume the same reference. Provider-specific image
  blocks and UI object URLs are projections created only at their final boundary.

## Retention and compatibility

Public `proc.media.write/read/delete` calls no longer exist. Producers use
filesystem transfer primitives and submit a `ResourceBlock`; adapter ingress
uses a private streamed Process write because the adapter body is not itself a
filesystem target. The Process validates ownership and exact revision, then
retains the bytes once under `~/.gsv/media` before committing durable history.
Already-owned archive references are reused without another RPC or R2 copy.

Legacy Process histories can still contain `/var/media` descriptors, and old
conversation records can still point at conversation media. Their read paths
remain until a deliberate stored-data migration removes those representations.
New messages and tool results do not create either form.

The compatibility tool-result bridge accepts old inline provider image blocks,
extracts their bytes, persists only a reference, and rehydrates bytes while
assembling model context. Base64 is therefore confined to legacy input and
provider APIs that require it.

## Implementation order

1. Define and strictly validate the reference and resource-block protocol types.
2. Return revision-bound references from image-bearing `fs.read` without
   materializing base64.
3. Resolve exact source revisions through `fs.transfer.send`, retain them in the
   run-as agent's immutable archive, and project provider image content only
   while assembling model context.
4. Resolve the same reference lazily in Web and Desktop, reject a mismatched
   revision, and cache by revision.
5. Upload client files through `fs.transfer.receive`; stream adapter bodies
   through the private Process boundary; preserve authorization and replay
   fences in both paths.
6. Remove public process-media orchestration while retaining stored-history
   compatibility readers.

The encoding is structured and non-authoritative. Source expiry is explicit
when present. Durable Process retention occurs before a message or tool result
is committed. If an agent reads a file, edits it, and reads it again, the path
may be the same but the revisions differ; each history entry continues to
resolve the bytes that existed at that moment.
