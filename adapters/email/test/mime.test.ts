import { describe, expect, it } from "vitest";
import { parseMail } from "../src/mime";

const encoder = new TextEncoder();

describe("managed mail MIME parsing", () => {
  it("extracts bounded metadata while leaving attachment bytes in canonical raw", async () => {
    const raw = encoder.encode([
      "From: Mike <mike@example.com>",
      "To: Hank <hank@gsv.space>",
      "Subject: Hello",
      "Message-ID: <one@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=example",
      "",
      "--example",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Checking in.",
      "--example",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=note.bin",
      "Content-Transfer-Encoding: base64",
      "",
      "AQID",
      "--example--",
      "",
    ].join("\r\n"));

    const parsed = await parseMail(raw, {
      intakeId: "mail_one",
      digest: "sha256:one",
      receivedAt: 1_000,
      envelopeFrom: "mike@example.com",
      envelopeTo: "hank@gsv.space",
    });

    expect(parsed.metadata).toMatchObject({
      intakeId: "mail_one",
      rawSize: raw.byteLength,
      subject: "Hello",
      from: { name: "Mike", address: "mike@example.com" },
      attachments: [{ filename: "note.bin", size: 3 }],
    });
    expect(parsed.metadata.text?.trim()).toBe("Checking in.");
    expect(parsed.metadata.attachments[0]).not.toHaveProperty("content");
    expect(parsed.summaryInput).toEqual({
      from: "mike@example.com",
      subject: "Hello",
      text: "Checking in.",
    });
  });

  it("rejects MIME headers beyond the parser budget", async () => {
    const raw = encoder.encode(
      `X-Oversized: ${"x".repeat(300 * 1024)}\r\n\r\nbody`,
    );

    await expect(parseMail(raw, {
      intakeId: "mail_headers",
      digest: "sha256:headers",
      receivedAt: 1_000,
      envelopeFrom: "sender@example.com",
      envelopeTo: "hank@gsv.space",
    })).rejects.toThrow();
  });
});
