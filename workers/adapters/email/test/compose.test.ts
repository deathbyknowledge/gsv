import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { composeMail, type ComposedMail } from "../src/compose";

const MAIL: ComposedMail = {
  from: "hank@ship.space",
  fromName: "Hank Hill",
  to: ["anna@example.com", "mike@example.com"],
  cc: ["bob@example.com"],
  subject: "Friday",
  text: "See you then.\n",
  html: "<!doctype html><html><body><p>See you then.</p></body></html>\n",
};

/** A part's text as written: PostalMime keeps the line break that belongs to the next boundary. */
function partText(text: string | undefined): string | undefined {
  return text?.replace(/\n$/, "");
}

describe("composeMail", () => {
  it("writes a message every reader parses back to what was sent", async () => {
    const parsed = await PostalMime.parse(composeMail({
      ...MAIL,
      inReplyTo: "<original@example.com>",
      references: "<older@example.com> <original@example.com>",
    }));

    expect(parsed).toMatchObject({
      from: { address: "hank@ship.space", name: "Hank Hill" },
      to: [{ address: "anna@example.com" }, { address: "mike@example.com" }],
      cc: [{ address: "bob@example.com" }],
      subject: "Friday",
      inReplyTo: "<original@example.com>",
      references: "<older@example.com> <original@example.com>",
    });
    expect(partText(parsed.text)).toBe("See you then.\n");
    expect(partText(parsed.html)).toBe(MAIL.html);
    expect(parsed.attachments).toEqual([]);
  });

  it("keeps lines short, 7-bit and CRLF, and leaves Date and Message-ID to Email Sending", () => {
    const mime = composeMail({
      ...MAIL,
      fromName: "Zoë Ångström-Øresund, Esq.",
      subject: `Cena del viernes: ${"¿quién trae el postre? ".repeat(6).trim()}`,
      references: Array.from({ length: 6 }, (_, index) => `<message-${index}@mail.example.com>`).join(" "),
      text: `${"Ünïcödé text that runs well past one line ".repeat(5)}\n= sign, trailing space \n\nend\n`,
    });

    const [head] = mime.split("\r\n\r\n", 1);
    expect(mime).not.toMatch(/\r(?!\n)|(?<!\r)\n/);
    expect(mime).toMatch(/^\p{ASCII}*$/u);
    expect(mime.split("\r\n").filter((line) => line.length > 78)).toEqual([]);
    expect(head).not.toMatch(/^(Date|Message-ID):/im);
    expect(head).toContain("MIME-Version: 1.0");
    expect(head).toMatch(/Content-Type: multipart\/alternative;\r\n boundary="=_gsv_[0-9a-f]{32}"/);
  });

  it("encodes an ASCII subject whose words are too long to fold, so its lines stay short", async () => {
    const link = `See https://example.com/${"a".repeat(120)} first`;
    const unbroken = "x".repeat(998);

    for (const subject of [link, unbroken]) {
      const mime = composeMail({ ...MAIL, subject });

      expect(mime.split("\r\n").filter((line) => line.length > 78)).toEqual([]);
      expect((await PostalMime.parse(mime)).subject).toBe(subject);
    }
  });

  it("round-trips names and subjects outside ASCII, quotes and whitespace intact", async () => {
    const subject = `Cena del viernes: ${"¿quién trae el postre? ".repeat(6).trim()}`;
    const text = `${"Ünïcödé text that runs well past one line ".repeat(5)}\n= sign, trailing space \n\nend\n`;
    const accented = await PostalMime.parse(composeMail({ ...MAIL, fromName: "Zoë Ångström", subject, text }));
    const quoted = await PostalMime.parse(composeMail({ ...MAIL, fromName: 'Hank "The Tank" Hill \\ Co' }));
    const lookalike = await PostalMime.parse(composeMail({ ...MAIL, subject: "=?UTF-8?B?SGk=?= is literal" }));

    expect(accented.from).toEqual({ address: "hank@ship.space", name: "Zoë Ångström" });
    expect(accented.subject).toBe(subject);
    expect(partText(accented.text)).toBe(text);
    expect(quoted.from).toEqual({ address: "hank@ship.space", name: 'Hank "The Tank" Hill \\ Co' });
    expect(lookalike.subject).toBe("=?UTF-8?B?SGk=?= is literal");
  });

  it("writes a bare address when the owner has no display name", () => {
    const mime = composeMail({ ...MAIL, fromName: undefined, cc: undefined });

    expect(mime).toMatch(/^From: hank@ship\.space\r\nTo: anna@example\.com, mike@example\.com\r\nSubject: Friday\r\n/);
    expect(mime).not.toMatch(/^Cc:/m);
  });
});
