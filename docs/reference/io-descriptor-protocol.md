# I/O Descriptor Protocol

Status: draft

GSV syscalls are JSON operations. Some syscall inputs and outputs are byte
streams that do not belong inline in JSON. The I/O descriptor protocol adds a
Unix-like byte-stream layer below syscalls.

The model is:

- JSON frames describe operations and structured results.
- I/O descriptors are transient, connection-scoped stream capabilities.
- Binary frames carry bytes for those descriptors until EOF or error.
- Syscalls create, consume, or relay descriptors.

This replaces the conceptual role of `fs.transfer.*` as a public filesystem
protocol. `fs.transfer.*` can remain as a compatibility layer, but the lower
layer should be generic and usable by any syscall.

## Design Goals

- Let any syscall move bytes without embedding bytes in JSON.
- Preserve the existing syscall request and response model.
- Keep descriptor authority tied to the syscall that created it.
- Support native, device-routed, and device-to-device streams.
- Keep process history model-safe by storing metadata, not raw stream bytes.
- Preserve the existing binary frame format where possible.

## Descriptor Records

JSON request, response, and signal frames may include an optional `fds` field.

```ts
type IoDescriptor = {
  fd: number;
  mode: "read" | "write" | "duplex";
  kind: "bytes";
  size?: number;
  contentType?: string;
  name?: string;
  maxBytes?: number;
  expiresAt?: number;
};
```

Descriptor numbers are scoped to a single WebSocket connection. They are not
durable identifiers and must not be persisted as storage references.

Structured syscall args, response data, and signal payloads refer to descriptors
with an fd reference:

```ts
type FdRef = { "$fd": number };
```

Every fd reference in a JSON frame must have a matching descriptor in that
frame's `fds` array.

## Descriptor Direction

Descriptor mode is from the receiver's point of view.

- `read`: the receiver may read bytes from the descriptor.
- `write`: the receiver may write bytes to the descriptor.
- `duplex`: the receiver may both read and write.

Example download response:

```json
{
  "type": "res",
  "id": "req_1",
  "ok": true,
  "data": {
    "ok": true,
    "path": "/home/alice/big.bin",
    "size": 104857600,
    "content": { "$fd": 42 }
  },
  "fds": [
    {
      "fd": 42,
      "mode": "read",
      "kind": "bytes",
      "size": 104857600,
      "contentType": "application/octet-stream"
    }
  ]
}
```

Example upload request:

```json
{
  "type": "req",
  "id": "req_2",
  "call": "fs.write",
  "args": {
    "path": "/home/alice/big.bin",
    "content": { "$fd": 7 }
  },
  "fds": [
    {
      "fd": 7,
      "mode": "read",
      "kind": "bytes",
      "size": 104857600
    }
  ]
}
```

In the upload example, the receiver of the request can read from fd `7`; the
sender writes binary frames for fd `7`.

## Binary Frame Format

Binary frames use the existing GSV binary frame shape:

```text
[u32 fd little-endian][u8 flags][payload bytes]
```

Flags:

```ts
const DATA = 0x01;
const EOF = 0x02;
const ERROR = 0x04;
const CLOSE = 0x08;
```

Rules:

- `DATA` appends payload bytes to the stream.
- `EOF` closes the write side and signals end of stream.
- `ERROR` closes the descriptor with a UTF-8 error payload.
- `CLOSE` cancels the descriptor from the receiver side.
- `DATA | EOF` is valid for final bytes.
- `ERROR` implies close.
- Frames for unknown descriptors are ignored or rejected.
- Implementations must bound queued early frames.

## Lifecycle

A descriptor is live from the moment its JSON frame is accepted until one of:

- EOF
- error
- explicit close
- timeout
- max byte violation
- route cancellation
- WebSocket close

Descriptors are transient capabilities. They inherit authority from the syscall
that created them. Possessing a live descriptor is sufficient authority to use
that stream according to its mode.

## Routing

The Kernel registers descriptor routes before forwarding JSON frames that carry
`fds`.

For a routed request:

```text
origin sends request + fds
Kernel registers descriptor route
Kernel forwards request to target
binary frames relay according to descriptor mode
```

For a routed response:

```text
target sends response + fds
Kernel registers descriptor route
Kernel forwards response to origin
binary frames relay according to descriptor mode
```

The Kernel may map fd numbers between connections:

```text
client fd 42 <-> kernel route <-> device fd 9001
```

The first implementation may use the same numeric fd across a route, but the
protocol should not require that.

Native handlers can create descriptors directly by returning descriptor records
and attaching a producer or consumer stream inside the Kernel.

## Process History

Process tool results should not store raw descriptor bytes. Model history should
store bounded textual metadata, for example:

```json
{
  "ok": true,
  "path": "/home/alice/big.bin",
  "size": 104857600,
  "content": "[stream fd=42 application/octet-stream 100 MB]"
}
```

Durable references should be paths, media ids, object URIs, archive ids, or
other stable records. Descriptors are live transport capabilities only.

## Syscall Conventions

### `fs.read`

Default behavior remains model-safe and compatible:

```ts
fs.read({ path })
```

`mode: "stream"` returns a descriptor:

```ts
fs.read({ path, mode: "stream" })
```

Example result:

```json
{
  "ok": true,
  "path": "/home/alice/big.bin",
  "size": 104857600,
  "content": { "$fd": 42 }
}
```

`mode: "auto"` may return inline text for small text files and a descriptor for
large or binary files.

### `fs.write`

`fs.write` may continue accepting inline text:

```ts
fs.write({ path, content: "hello" })
```

It may also accept an fd reference:

```ts
fs.write({ path, content: { "$fd": 42 } })
```

### `fs.copy`

`fs.copy` should become a descriptor operation internally:

- Open source as a readable descriptor.
- Open destination as a writable sink.
- Relay, splice, or copy bytes between the two.

This covers native-to-native, native-to-device, device-to-native, and
device-to-device copy without exposing `fs.transfer.*` as the core abstraction.

### `fs.transfer.*`

`fs.transfer.stat`, `fs.transfer.send`, and `fs.transfer.receive` can remain as
legacy compatibility syscalls. They should be implemented on top of the generic
descriptor layer over time.

## Minimal `io.*` Surface

Most callers should not need direct `io.*` syscalls. Normal domain syscalls
create and consume descriptors.

A minimal public surface may include:

```ts
io.close({ fd })
io.stat({ fd })
```

Possible future additions:

```ts
io.pipe()
io.splice({ from, to, limit? })
```

`io.splice` should be treated as an optimization and routing primitive, not as a
requirement for ordinary clients.

## SDK Shape

Download:

```ts
const result = await client.fs.read({ path: "big.bin", mode: "stream" });
const stream = client.io.read(result.content);
```

Upload:

```ts
const fd = client.io.fromStream(file.stream(), { size: file.size });
await client.fs.write({ path: "big.bin", content: fd.ref });
```

The SDK should hide descriptor route setup and binary frame handling from most
application code.

## Migration Plan

1. Document the real binary frame format in the WebSocket reference.
2. Add optional `fds` to JSON frame types.
3. Rename SDK-facing `streamId` concepts to `fd` while preserving wire
   compatibility.
4. Teach Kernel routing to register descriptors from frame metadata instead of
   checking syscall names such as `fs.transfer.send`.
5. Reimplement `fs.transfer.*` as compatibility shims over descriptors.
6. Add descriptor modes to `fs.read` and `fs.write`.
7. Move `fs.copy`, media reads, repo blobs, package artifacts, and fetch bodies
   onto the same descriptor layer.

## Open Questions

- Should descriptor refs be allowed anywhere in `args`, `data`, and `payload`,
  or only in explicit syscall fields?
- Should `fds` be top-level on all JSON frames or limited to request/response
  frames?
- Should fd numbers be allocated only by the sender, only by the Kernel, or by
  whichever side creates the descriptor?
- Should the wire name be `fd` immediately, or should the implementation keep
  `streamId` internally during migration?
- What backpressure or windowing is needed beyond bounded queues and WebSocket
  buffering?
- How should descriptor metadata be represented in process history and client
  signals for model-facing tool results?
