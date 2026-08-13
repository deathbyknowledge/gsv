import { describe, expect, it } from "vitest";
import { parseMail } from "../src/mime";

const encoder = new TextEncoder();

function size(value: string | undefined): number {
  return encoder.encode(value ?? "").byteLength;
}

function input(overrides: Partial<Parameters<typeof parseMail>[1]> = {}) {
  return {
    intakeId: "mail_test",
    digest: `sha256:${"a".repeat(64)}`,
    receivedAt: 1_000,
    envelopeFrom: "mike@example.com",
    envelopeTo: "hank@gsv.space",
    ...overrides,
  };
}

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

    const parsed = await parseMail(raw, input({ intakeId: "mail_one" }));

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

    await expect(parseMail(raw, input({ intakeId: "mail_headers" })))
      .rejects.toThrow();
  });

  it("omits malformed optional header addresses", async () => {
    const raw = encoder.encode([
      "From: Broken <foo@>",
      "To: Valid <valid@example.com>, Broken <bar@>",
      "Reply-To: also-broken@",
      "Subject: malformed addresses",
      "",
      "body",
    ].join("\r\n"));

    const parsed = await parseMail(raw, input());

    expect(parsed.metadata.from).toBeUndefined();
    expect(parsed.metadata.to).toEqual([
      { name: "Valid", address: "valid@example.com" },
    ]);
    expect(parsed.metadata.replyTo).toEqual([]);
    expect(parsed.summaryInput.from).toBe("mike@example.com");
  });

  it("truncates multibyte metadata at Kernel UTF-8 byte limits", async () => {
    const longName = "😀".repeat(200);
    const longSubject = "界".repeat(2_000);
    const longMessageId = `<${"é".repeat(1_100)}@example.com>`;
    const raw = encoder.encode([
      `From: ${longName} <MIKE@EXAMPLE.COM>`,
      `Subject: ${longSubject}`,
      `Message-ID: ${longMessageId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
    ].join("\r\n"));

    const parsed = await parseMail(raw, input());

    expect(parsed.metadata.from?.address).toBe("mike@example.com");
    expect(size(parsed.metadata.from?.name)).toBe(512);
    expect(parsed.metadata.from?.name?.endsWith("😀")).toBe(true);
    expect(size(parsed.metadata.subject)).toBeLessThanOrEqual(4_096);
    expect(parsed.metadata.subject?.endsWith("界")).toBe(true);
    expect(size(parsed.summaryInput.subject)).toBeLessThanOrEqual(1_024);
    expect(parsed.summaryInput.subject.endsWith("界")).toBe(true);
    expect(size(parsed.metadata.rfcMessageId)).toBeLessThanOrEqual(2_048);
    expect(parsed.metadata.rfcMessageId?.endsWith("�")).toBe(false);
  });

  it("rejects malformed or overlong envelope addresses", async () => {
    const raw = encoder.encode("Subject: hello\r\n\r\nbody");

    await expect(parseMail(raw, input({ envelopeFrom: "foo@" })))
      .rejects.toThrow("Managed mail envelopeFrom is invalid");
    await expect(parseMail(raw, input({
      envelopeTo: `${"é".repeat(251)}@example.com`,
    }))).rejects.toThrow("Managed mail envelopeTo is invalid");
  });

  it("bounds parsed bodies and attachment metadata for Gateway intake", async () => {
    const longFilename = `${"😀".repeat(300)}.txt`;
    const body = "界".repeat(1_398_200);
    const raw = encoder.encode([
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=example",
      "",
      "--example",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "--example",
      "Content-Type: application/octet-stream",
      `Content-Disposition: attachment; filename=\"${longFilename}\"`,
      "Content-ID: <file@example.com>",
      "Content-Transfer-Encoding: base64",
      "",
      "AQID",
      "--example--",
      "",
    ].join("\r\n"));

    const parsed = await parseMail(raw, input());

    expect(size(parsed.metadata.text)).toBeLessThanOrEqual(128 * 1024);
    expect(parsed.metadata.text?.endsWith("界")).toBe(true);
    expect(size(parsed.summaryInput.text)).toBeLessThanOrEqual(64 * 1024);
    expect(parsed.summaryInput.text.endsWith("界")).toBe(true);
    expect(parsed.metadata.attachments).toHaveLength(1);
    expect(size(parsed.metadata.attachments[0].mimeType)).toBeLessThanOrEqual(256);
    expect(size(parsed.metadata.attachments[0].filename)).toBeLessThanOrEqual(1_024);
    expect(parsed.metadata.attachments[0].filename?.endsWith("�")).toBe(false);
    expect(parsed.metadata.attachments[0].disposition).toBe("attachment");
  });

  it("sanitizes summary-only fields for the inference boundary", async () => {
    const raw = encoder.encode([
      "Subject: =?UTF-8?Q?line=0Abreak?=",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "\0",
    ].join("\r\n"));

    const parsed = await parseMail(raw, input());
    const empty = await parseMail(encoder.encode([
      "Content-Type: text/plain; charset=utf-8",
      "",
      "\0",
    ].join("\r\n")), input());

    expect(parsed.summaryInput.subject).not.toMatch(/[\r\n\0]/);
    expect(parsed.summaryInput.text).not.toContain("\0");
    expect(parsed.metadata.subject).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(empty.summaryInput.text).toBe("Message has no text body");
  });

  it("keeps serialized parsed metadata below the SQLite value limit", async () => {
    const controls = "\u0000".repeat(700 * 1024);
    const raw = encoder.encode([
      "MIME-Version: 1.0",
      "Content-Type: multipart/alternative; boundary=example",
      "",
      "--example",
      "Content-Type: text/plain; charset=utf-8",
      "",
      controls,
      "--example",
      "Content-Type: text/html; charset=utf-8",
      "",
      controls,
      "--example--",
      "",
    ].join("\r\n"));

    const parsed = await parseMail(raw, input());

    expect(encoder.encode(JSON.stringify(parsed.metadata)).byteLength)
      .toBeLessThan(1024 * 1024);
  });
});
