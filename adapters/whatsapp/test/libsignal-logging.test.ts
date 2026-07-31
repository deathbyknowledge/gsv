import { Buffer } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type SyntheticSession = {
  indexInfo: {
    baseKey: Buffer;
    closed: number;
  };
  keyMaterial: {
    privateKey: Buffer;
    publicKey: Buffer;
  };
};

type InternalSessionRecord = {
  closeSession: (session: SyntheticSession) => void;
  openSession: (session: SyntheticSession) => void;
};

type InternalSessionRecordConstructor = new () => InternalSessionRecord;

type InternalSessionCipher = {
  decryptWithSessions: (
    data: Buffer,
    sessions: SyntheticSession[],
  ) => Promise<unknown>;
  doDecryptWhisperMessage: (
    data: Buffer,
    session: SyntheticSession,
  ) => Promise<Buffer>;
};

type InternalSessionCipherConstructor = {
  prototype: InternalSessionCipher;
};

const require = createRequire(import.meta.url);
const SessionRecord = require(
  "libsignal/src/session_record",
) as InternalSessionRecordConstructor;
const SessionCipher = require(
  "libsignal/src/session_cipher",
) as InternalSessionCipherConstructor;

const syntheticSession = (id: number, closed = -1): SyntheticSession => ({
  indexInfo: {
    baseKey: Buffer.from([id]),
    closed,
  },
  keyMaterial: {
    privateKey: Buffer.from(`synthetic-private-${id}`),
    publicKey: Buffer.from(`synthetic-public-${id}`),
  },
});

describe("patched dependency logging", () => {
  it("never passes Signal sessions, keys, or error details to console", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const record = new SessionRecord();
    const sensitiveSession = syntheticSession(255);

    record.closeSession(sensitiveSession);
    record.closeSession(sensitiveSession);
    record.openSession(sensitiveSession);
    record.openSession(sensitiveSession);

    const errorMarker = "synthetic-signal-error-detail";
    const cipher = Object.create(
      SessionCipher.prototype,
    ) as InternalSessionCipher;
    cipher.doDecryptWhisperMessage = async () => {
      throw new Error(errorMarker);
    };
    await expect(cipher.decryptWithSessions(
      Buffer.from([0]),
      [sensitiveSession],
    )).rejects.toThrow("No matching sessions found for message");

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("routes or removes dependency console calls that included raw errors", () => {
    const baileysRoot = dirname(require.resolve("@whiskeysockets/baileys"));
    const communities = readFileSync(
      join(baileysRoot, "Socket", "communities.js"),
      "utf8",
    );
    const business = readFileSync(
      join(baileysRoot, "Utils", "business.js"),
      "utf8",
    );
    const libsignalSource = readJavaScriptTree(dirname(
      require.resolve("libsignal/src/session_record"),
    ));

    expect(communities).not.toMatch(/logger\.(?:info|warn|error)/);
    expect(communities).not.toContain("../Utils/logger.js");
    expect(business).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
    expect(libsignalSource).not.toMatch(
      /console\.(?:log|info|warn|error|debug)\s*\(/,
    );
  });
});

function readJavaScriptTree(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readJavaScriptTree(path);
      return entry.isFile() && entry.name.endsWith(".js")
        ? readFileSync(path, "utf8")
        : "";
    })
    .join("\n");
}
