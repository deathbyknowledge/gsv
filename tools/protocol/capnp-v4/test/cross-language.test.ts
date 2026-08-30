/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- The controlled Rust bridge emits JSON which this interoperability test asserts against its typed corpus. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import corpus from "../corpus/v3-frames.json";
import { decodeV4BinaryMessage, encodeV4ControlMessage } from "../src/codec";
import type { ControlFrame } from "../src/types";

const frames = corpus.map((entry) => entry.frame as ControlFrame);
const manifest = fileURLToPath(new URL("../rust/Cargo.toml", import.meta.url));

describe.each([false, true])("TypeScript/Rust compatibility (packed=%s)", (packed) => {
  it("decodes TypeScript bytes in Rust", () => {
    const encoded = frames.map((frame) => arrayBufferToBase64(encodeV4ControlMessage(frame, { packed })));
    const decoded = runRust("decode", packed, encoded) as ControlFrame[];
    expect(decoded).toEqual(frames);
  });

  it("decodes Rust bytes in TypeScript", () => {
    const encoded = runRust("encode", packed, frames) as string[];
    const decoded = encoded.map((value) => {
      const message = decodeV4BinaryMessage(base64ToArrayBuffer(value));
      if (message.kind !== "control") throw new Error("Rust returned a body frame");
      expect(message.packed).toBe(packed);
      return message.frame;
    });
    expect(decoded).toEqual(frames);
  });
});

function runRust(command: "encode" | "decode", packed: boolean, input: unknown): unknown {
  const commandArguments = [
    "run",
    "--quiet",
    "--manifest-path",
    manifest,
    "--",
    command,
  ];
  if (packed) commandArguments.push("--packed");
  return JSON.parse(
    execFileSync("cargo", commandArguments, {
      encoding: "utf8",
      input: JSON.stringify(input),
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64");
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  return bytes.buffer;
}
