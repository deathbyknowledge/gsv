import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compressProfile, decodeProfile, encryptProfile } from "../src/profile-codec";

describe("bounded profile encoding", () => {
  it("keeps exact JSON hashes and the encrypted format across chunk boundaries", async () => {
    const value = { text: `${"x".repeat(16383)}😀\ud800\n\u0000"\\${"é".repeat(32768)}`, nothing: null, flags: [false, 0, "", true], nested: { another: "value" } };
    const encoded = await compressProfile(value, 1024 * 1024);
    expect(encoded.hash).toBe(createHash("sha256").update(JSON.stringify(value)).digest("hex"));
    expect(encoded.bytes).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12)), address = "installation/owner/profile/revision";
    const encrypted = await encryptProfile(encoded.chunks, encoded.compressedBytes, key, iv, address);
    expect(encoded.chunks).toHaveLength(0);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address) }, key, encrypted);
    expect(await decodeProfile(new Uint8Array(plaintext))).toBe(JSON.stringify(value));
    await expect(decodeProfile(new TextEncoder().encode(JSON.stringify(value)))).rejects.toThrow("Unsupported saved browser format");
  });
  it("rejects an oversized serialization without creating a complete encoded copy", async () => {
    await expect(compressProfile({ value: "x".repeat(1024 * 1024) }, 4096)).rejects.toThrow("4096-byte allowance");
    const controller = new AbortController(); controller.abort(new Error("Stopped"));
    await expect(compressProfile({ value: "x" }, 4096, controller.signal)).rejects.toThrow("Stopped");
  });
});
