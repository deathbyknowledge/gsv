# Cap'n Proto protocol-v4 spike

This spike answers HAM-641. Its conclusion is **do not negotiate protocol v4 from this design**. The implementation is interoperable on every tested runtime, but the measured TypeScript cost and wire size do not justify replacing protocol-v3 JSON.

This is an isolated experiment, not a production protocol path. It does not change `PROTOCOL_VERSION`, connect negotiation, the Kernel, the public client, or a host application.

## Boundary and carrier

The invariant is that Cap'n Proto is a WebSocket control-frame encoding only. The codec materializes ordinary request, response, and signal values before domain dispatch. Generated readers never leave the protocol boundary. Existing per-syscall validation remains necessary after transport decoding.

Body bytes retain the existing five-byte binary carrier and stream lifecycle. The v4 experiment uses the already-invalid `streamId = 0` as the control discriminator:

```text
byte 0..3  little-endian stream ID
byte 4     stream 0: 0 = standard Cap'n Proto, 1 = packed Cap'n Proto
           stream >0: unchanged protocol-v3 body flags
byte 5..   Cap'n Proto control message or unchanged body payload
```

Every body descriptor requires a nonzero stream ID. A nonzero carrier stream ID bypasses the Cap'n Proto decoder and returns the existing body payload view. Typed service-binding RPC and `ReadableStream` bodies stay internal and unencoded.

## Answers

### 1. TypeScript traversal and copies

`capnp-es` 0.0.14 generated getters traverse fields lazily; the raw single-segment mutation probe proves that a getter observes a mutation made after opening the root. That does **not** make its normal wire decoder zero-copy:

- A standard framed `ArrayBuffer` is parsed immediately and every segment is copied with `slice()`.
- An `ArrayBufferView` is copied to an exact buffer before parsing.
- Packed input is completely expanded into a new buffer and its framed segments are then copied.
- Text and list/object domain values are materialized when their getters are traversed.
- Only the runtime's raw `singleSegment` mode can traverse an `ArrayBuffer` without the framed-segment copy. It is not the standard cross-language stream format and was kept as a measurement probe, not proposed as v4.

The five-byte GSV carrier also means a standard Cap'n Proto message starts at an unaligned offset. Rust's `unaligned` feature reads that slice without copying; TypeScript needs an exact-buffer copy before `capnp-es` performs its own segment copies.

The library itself describes the release as alpha-quality. See [`capnp-es` v0.0.14](https://github.com/unjs/capnp-es/tree/v0.0.14).

### 2. One schema and generated APIs

One 86-line schema generated compatible APIs and passed every TS-to-Rust and Rust-to-TS corpus case in standard and packed form. The generic recursive `JsonValue` union is necessary to carry the current open set of syscall arguments and results without embedding JSON bytes.

The direct APIs are not ergonomic enough to expose:

| Artifact | Size |
| --- | ---: |
| Current schema | 86 lines |
| Generated TypeScript | 696 lines / 21,795 bytes |
| Generated Rust | 3,835 lines / about 195 KB |
| TypeScript boundary codec | 678 lines |
| Rust boundary codec and tests | 1,066 lines |

TypeScript initialization uses mutable generated classes and underscore-prefixed methods such as `_initRequest()` and `_initObjectValue()`. Rust uses conventional readers/builders but is verbose. Both need a hand-written boundary adapter to preserve absent versus explicit `null`, validate semantic invariants, enforce limits, and return ordinary domain values.

### 3. Bytes, CPU, and allocations

The corpus contains 12 representative protocol-v3 requests, responses, signals, nested resources, Unicode, errors, and body descriptors. All Cap'n Proto sizes below include the five-byte v4 carrier per frame. Results are medians after warmup on the environment in [`results/environment.json`](./results/environment.json).

Wire bytes from the TypeScript encoder:

| Encoding | Corpus bytes | Mean/frame | Versus v3 |
| --- | ---: | ---: | ---: |
| Protocol-v3 JSON | 3,019 | 251.6 | baseline |
| Cap'n Proto standard | 8,636 | 719.7 | 2.86x / +186% |
| Cap'n Proto packed | 4,133 | 344.4 | 1.37x / +37% |

Rust uses a tuned 256-word initial segment instead of the runtime's 1,024-word default. Its sender produced 8,716 standard bytes and 4,154 packed bytes because the largest messages crossed segments and needed far pointers. Both encodings decode identically; serialized layout is not required to be byte-identical between implementations.

Median CPU time in microseconds per frame:

| Runtime | Encoding | Encode | Decode |
| --- | --- | ---: | ---: |
| Node 24.20 | JSON | 0.803 | 1.027 |
| Node 24.20 | standard | 45.650 | 63.857 |
| Node 24.20 | packed | 48.023 | 66.289 |
| Chromium 151 | JSON | 0.583 | 1.167 |
| Chromium 151 | standard | 63.250 | 61.833 |
| Chromium 151 | packed | 61.250 | 58.583 |
| Rust 1.100 nightly | JSON | 0.296 | 1.687 |
| Rust 1.100 nightly | standard | 0.553 | 1.772 |
| Rust 1.100 nightly | packed | 0.964 | 2.469 |

The Node/Chromium difference is decisive even allowing for microbenchmark variance: the safe, materializing `capnp-es` path is tens of times slower than native JSON. Rust is much closer, but it cannot offset the browser/Worker boundary cost.

Rust allocations are counted by a global allocator around each measured operation:

| Encoding | Encode calls / bytes | Decode calls / bytes |
| --- | ---: | ---: |
| JSON | 2.17 / 619 | 23.67 / 3,086 |
| standard | 7.50 / 3,692 | 30.50 / 2,028 |
| packed | 10.42 / 3,603 | 31.50 / 2,750 |

Standard Cap'n Proto decode allocates fewer total Rust bytes than JSON decode, but makes more allocation calls. Encoding makes about 3.5x as many calls and allocates about 6x the bytes even after tuning the first segment. Node's retained-batch deltas are recorded but are not presented as allocation counts because V8 does not expose complete per-operation allocation accounting.

Exact benchmark output is in [`results/node.json`](./results/node.json), [`results/browser.json`](./results/browser.json), and [`results/rust.json`](./results/rust.json).

### 4. Runtime reliability

The same codec and corpus passed on:

- Node 24.20.0: 23 TypeScript tests, including the current protocol-v3 validators and both cross-language directions.
- Chromium 151: all 12 frames in both encodings, an ownership-transferring `MessageChannel`, and a `Blob.arrayBuffer()` path.
- workerd 2026-07-22: binary `Request`/`Response` and `WebSocketPair` paths in both encodings. Modern Workers WebSocket semantics require `binaryType = "arraybuffer"` before `accept()` for synchronous ArrayBuffer delivery; the Durable Object hibernation handler remains ArrayBuffer-based according to the [Workers WebSocket documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/#binary-messages).
- Rust with `capnp` 0.27.0: 10 unit/evolution/hostile-input tests plus the shared cross-language tests.

The minified Worker probe bundle is 64,766 bytes (17,125 bytes gzip). Functionality is viable, but production reliability is not established: `capnp-es` is alpha, the safe wrapper depends on internal `_capnp` controls, and the wrapper is much larger than the schema.

### 5. Evolution and hostile input

Evolution probes use the same schema ID with a v0 snapshot:

- An old reader accepts a new ordinary request field.
- Forwarding the original message segments preserves that unknown field.
- Materializing to domain values and rebuilding intentionally drops it.
- A new union variant appears as `NotInSchema(3)` in Rust and discriminant `3` in TypeScript. The boundary rejects it rather than guessing.

The prototype fails closed with explicit 1 MiB control-frame, 16-segment, 64-level nesting, and 65,536-node limits. It validates the complete segment table and rejects trailing bytes, invalid UTF-8, missing required pointers, non-finite numbers, duplicate object keys, invalid body descriptors, and unknown variants.

The wrapper performs its own bounded packed preflight/unpack. Source inspection found that `capnp-es` otherwise computes and allocates the complete packed expansion before an application limit, does not cap framed segment count, uses a non-fatal text decoder, and does not install the intended 64-level depth limit on a generated root by default. Rust additionally uses `ReaderOptions` traversal and nesting limits. See the [Cap'n Proto encoding](https://capnproto.org/encoding.html) and [Rust `ReaderOptions`](https://docs.rs/capnp/latest/capnp/message/struct.ReaderOptions.html) documentation.

Schema evolution is therefore usable for endpoints that understand a negotiated version, but transparent unknown-field forwarding is incompatible with the required materializing domain boundary.

### 6. Domain mapping

All requests, responses, and signals emerge as plain TypeScript objects or Rust `serde_json::Value` trees. Generated readers are confined to `src/codec.ts` and `rust/src/lib.rs`. Explicit null and absent optional values remain distinct. Object keys are sorted on encode for deterministic cross-runtime output and defined safely on decode so `__proto__` remains data.

There are three semantic edges relative to unconstrained JavaScript JSON:

- Lone UTF-16 surrogates cannot be represented by Cap'n Proto `Text` and are rejected instead of silently becoming U+FFFD.
- Rust rejects integer JSON values beyond JavaScript's safe-integer range rather than silently rounding them through `Float64`; protocol v3 already has a JS/Rust asymmetry there.
- Object insertion order is canonicalized even though JSON object meaning is unordered.

The generic schema does not replace syscall-specific validation. Running existing call validators after materialization is still mandatory.

## Cap'n Web

Cap'n Web was not evaluated, imported, or used. This spike covers only Cap'n Proto serialization and GSV's existing WebSocket carrier.

## Reproduce

Install repository dependencies, then run:

```bash
npx tsc -p tools/protocol/capnp-v4/tsconfig.json
npx vitest run \
  tools/protocol/capnp-v4/test/codec.test.ts \
  tools/protocol/capnp-v4/test/cross-language.test.ts \
  tools/protocol/capnp-v4/test/v3-validation.test.ts
npx vitest run --config tools/protocol/capnp-v4/vitest.worker.config.ts
node tools/protocol/capnp-v4/browser/run.mjs

cd tools/protocol/capnp-v4/rust
cargo fmt --check
cargo test
cargo run --release --quiet -- benchmark ../corpus/v3-frames.json 1000

cd ../../../..
node --expose-gc tools/protocol/capnp-v4/benchmark/run-node.mjs 1000
```

Regeneration additionally requires Cap'n Proto 1.5.0 and `capnpc-rust` 0.27.0 on `PATH`:

```bash
tools/protocol/capnp-v4/generate.sh
```

`capnp-es` 0.0.14 and `esbuild` 0.28.1 are exact root development dependencies. The Rust prototype is an isolated workspace with a committed lockfile; no Cap'n Proto dependency enters a production host crate.
