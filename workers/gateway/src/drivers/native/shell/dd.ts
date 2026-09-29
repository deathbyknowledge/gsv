import { defineCommand, type ByteString, type ExecResult } from "just-bash";
import type { GsvFs } from "../../../fs/gsv-fs";

const DD_USAGE = [
  "dd [if=SOURCE] [of=DEST] [bs=BYTES] [count=N] [skip=N] [seek=N] [conv=notrunc] [status=none]",
  "",
  "Copy raw bytes, optionally skipping input blocks and seeking output blocks.",
  "Without if= the standard input is read; without of= the bytes go to standard output.",
  "bs accepts a plain byte count or a K, M, or G suffix; the default is 512.",
  "seek= keeps the existing bytes of DEST before the written range; the rest of",
  "DEST is truncated unless conv=notrunc keeps it.",
  "",
  "Examples:",
  "  dd if=archive.bin of=part.0 bs=150000 count=1",
  "  dd if=archive.bin of=part.1 bs=150000 skip=1 count=1",
  "  dd if=part.1 of=rejoined.bin bs=150000 seek=1",
  "  dd if=header.bin of=image.bin conv=notrunc",
  "",
].join("\n");

type DdOptions = {
  input?: string;
  output?: string;
  blockBytes: number;
  count?: number;
  skip: number;
  seek: number;
  quiet: boolean;
  truncate: boolean;
};

const BLOCK_SUFFIXES = new Map<string, number>([
  ["", 1],
  ["c", 1],
  ["b", 512],
  ["k", 1024],
  ["K", 1024],
  ["m", 1024 * 1024],
  ["M", 1024 * 1024],
  ["g", 1024 * 1024 * 1024],
  ["G", 1024 * 1024 * 1024],
]);

function parseBlockSize(value: string): number | null {
  const match = /^(\d+)([cbkKmMgG]?)$/.exec(value);
  if (!match) return null;
  const bytes = Number.parseInt(match[1], 10) * (BLOCK_SUFFIXES.get(match[2]) ?? 1);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function parseCount(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) ? count : null;
}

function parseDdOptions(args: string[]): DdOptions {
  const options: DdOptions = { blockBytes: 512, skip: 0, seek: 0, quiet: false, truncate: true };
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator <= 0) throw new Error(`unrecognized operand '${arg}'`);
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    switch (key) {
      case "if":
        options.input = value;
        break;
      case "of":
        options.output = value;
        break;
      case "bs": {
        const bytes = parseBlockSize(value);
        if (bytes === null) throw new Error(`invalid number: '${value}'`);
        options.blockBytes = bytes;
        break;
      }
      case "count":
      case "skip":
      case "seek": {
        const count = parseCount(value);
        if (count === null) throw new Error(`invalid number: '${value}'`);
        options[key] = count;
        break;
      }
      case "status":
        if (value !== "none" && value !== "noxfer" && value !== "progress") {
          throw new Error(`invalid status level: '${value}'`);
        }
        options.quiet = value === "none";
        break;
      case "conv":
        for (const conversion of value.split(",")) {
          if (conversion !== "notrunc") throw new Error(`unsupported conversion: '${conversion}'`);
          options.truncate = false;
        }
        break;
      default:
        throw new Error(`unrecognized operand '${arg}'`);
    }
  }
  return options;
}

/**
 * A byte-range copy for the gsv target, which has no dd applet. It reads the
 * source whole, so it is meant for the file sizes the cloud filesystem holds.
 */
export function buildDdCommand(fs: GsvFs) {
  return defineCommand("dd", async (args, ctx): Promise<ExecResult> => {
    if (args.includes("--help")) {
      return { stdout: DD_USAGE, stderr: "", exitCode: 0 };
    }
    let options: DdOptions;
    try {
      options = parseDdOptions(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `dd: ${message}\n`, exitCode: 1 };
    }

    let source: Uint8Array;
    if (options.input === undefined) {
      source = bytesFromPipe(ctx.stdin);
    } else {
      try {
        source = await fs.readFileBuffer(fs.resolvePath(ctx.cwd, options.input));
      } catch {
        return {
          stdout: "",
          stderr: `dd: failed to open '${options.input}': No such file or directory\n`,
          exitCode: 1,
        };
      }
    }

    const start = Math.min(options.skip * options.blockBytes, source.byteLength);
    const end = options.count === undefined
      ? source.byteLength
      : Math.min(start + options.count * options.blockBytes, source.byteLength);
    const copied = source.subarray(start, end);

    let stdout = "";
    if (options.output === undefined) {
      // Command output travels the pipeline as one char per byte.
      stdout = latin1FromUint8Array(copied);
    } else {
      const path = fs.resolvePath(ctx.cwd, options.output);
      const offset = options.seek * options.blockBytes;
      let written = copied;
      if (offset > 0 || !options.truncate) {
        // Like dd on a regular file: bytes before the seek offset survive, and
        // the tail past the written range survives only with conv=notrunc.
        const existing = await fs.readFileBuffer(path).catch(() => new Uint8Array());
        const end = offset + copied.byteLength;
        const length = options.truncate ? end : Math.max(existing.byteLength, end);
        written = new Uint8Array(length);
        written.set(existing.subarray(0, Math.min(existing.byteLength, length)));
        written.set(copied, offset);
      }
      try {
        await fs.writeFile(path, written);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { stdout: "", stderr: `dd: failed to open '${options.output}': ${message}\n`, exitCode: 1 };
      }
    }

    const fullBlocks = Math.floor(copied.byteLength / options.blockBytes);
    const partialBlocks = copied.byteLength % options.blockBytes === 0 ? 0 : 1;
    const stderr = options.quiet
      ? ""
      : `${fullBlocks}+${partialBlocks} records in\n${fullBlocks}+${partialBlocks} records out\n${copied.byteLength} bytes copied\n`;
    return { stdout, stderr, exitCode: 0 };
  });
}

/**
 * Shell pipes carry bytes packed one per char in a string branded as
 * ByteString. just-bash's accessor for that view is missing from its browser
 * bundle, which is what the Worker build resolves, so read the string directly.
 */
function bytesFromPipe(stdin: ByteString): Uint8Array {
  // ByteString is a branded latin1 string at runtime; String() returns it unchanged.
  return Uint8Array.from(String(stdin), (char) => char.charCodeAt(0));
}

function latin1FromUint8Array(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return text;
}
