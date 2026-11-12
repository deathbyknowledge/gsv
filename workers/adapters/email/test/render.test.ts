import { describe, expect, it } from "vitest";
import { mailFooter } from "../src/env";
import { renderMail } from "../src/render";

const FOOTER = { text: "Sent from my Ship", url: "https://ship.space" };

describe("outbound mail rendering", () => {
  it("renders a Ship's Markdown as HTML and as text without the marks", () => {
    const { html, text } = renderMail([
      "Could you book a table for **4 people** this *Friday*?",
      "Our earlier booking is [here](https://thefork.com/b/1234).",
      "",
      "Thanks,",
      "Esteve",
    ].join("\n"));

    expect(html).toContain("<strong>4 people</strong>");
    expect(html).toContain("<em>Friday</em>");
    expect(html).toContain("<a href=\"https://thefork.com/b/1234\">here</a>");
    expect(html).toContain("<p>Thanks,<br>Esteve</p>");
    expect(text).toBe([
      "Could you book a table for 4 people this Friday?",
      "Our earlier booking is here (https://thefork.com/b/1234).",
      "",
      "Thanks,",
      "Esteve",
      "",
    ].join("\n"));
  });

  it("keeps plain prose as written", () => {
    const prose = "Hi Anna,\n\nThe plan is 5 * 3 = 15, snake_case stays, and so do (brackets).\n\nBest,\nEsteve";

    expect(renderMail(prose).text).toBe(`${prose}\n`);
  });

  it("shows raw HTML as text and keeps only web and mail links", () => {
    const { html, text } = renderMail([
      "<img src=x onerror=alert(1)> <script>alert(1)</script>",
      "",
      "[run me](javascript:alert(1)) [relative](/settings) ![pixel](https://tracker.example/p.png)",
    ].join("\n"));

    expect(html).not.toMatch(/<img|<script|javascript:|href="\/settings"/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("run me");
    expect(html).toContain("<a href=\"https://tracker.example/p.png\">pixel</a>");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("run me relative pixel (https://tracker.example/p.png)");
  });

  it("decodes character references once, outside code", () => {
    const { html, text } = renderMail([
      "Confirm [here](https://example.com/confirm?id=1&amp;token=abc) or at <https://example.com/?a=1&amp;b=2>.",
      "",
      "Tom &amp; Jerry &copy; 2026 &#8212; &#x2192; ![a &amp; b](https://example.com/i.png) &madeup; `a &amp; b`",
    ].join("\n"));

    expect(html).toContain("<a href=\"https://example.com/confirm?id=1&amp;token=abc\">here</a>");
    expect(html).toContain("<a href=\"https://example.com/?a=1&amp;b=2\">https://example.com/?a=1&amp;b=2</a>");
    expect(html).toContain("Tom &amp; Jerry © 2026 — → <a href=\"https://example.com/i.png\">a &amp; b</a> &amp;madeup; <code");
    expect(html).toContain(">a &amp;amp; b</code>");
    expect(text).toBe([
      "Confirm here (https://example.com/confirm?id=1&token=abc) or at https://example.com/?a=1&b=2.",
      "",
      "Tom & Jerry © 2026 — → a & b (https://example.com/i.png) &madeup; a &amp; b",
      "",
    ].join("\n"));
  });

  it("checks a link only after decoding it", () => {
    const { html } = renderMail("[one](javascript&#58;alert(1)) [two](&#106;avascript:alert(1))");

    expect(html).not.toContain("href=");
    expect(html).toContain("one two");
  });

  it("renders lists, codes and addresses for both parts", () => {
    const { html, text } = renderMail([
      "Bring:",
      "",
      "- passport",
      "- [x] tickets",
      "",
      "1. Gate",
      "2. Seat",
      "",
      "```",
      "482913",
      "```",
      "",
      "Questions to anna@example.com, code `X-7`.",
    ].join("\n"));

    expect(html).toContain("<ul><li>passport</li><li style=\"list-style:none\">✓ tickets</li></ul>");
    expect(html).toContain("<ol><li>Gate</li><li>Seat</li></ol>");
    expect(html).toMatch(/<pre [^>]*>482913<\/pre>/);
    expect(html).toContain("<a href=\"mailto:anna@example.com\">anna@example.com</a>");
    expect(text).toBe([
      "Bring:",
      "",
      "- passport",
      "[x] tickets",
      "",
      "1. Gate",
      "2. Seat",
      "",
      "482913",
      "",
      "Questions to anna@example.com, code X-7.",
      "",
    ].join("\n"));
  });

  it("adds the operator footer under the message", () => {
    const { html, text } = renderMail("See you then.", { footer: FOOTER });

    expect(text).toBe("See you then.\n\nSent from my Ship (https://ship.space)\n");
    expect(html).toMatch(/<a href="https:\/\/ship\.space"[^>]*>Sent from my Ship<\/a>/);
    expect(renderMail("See you then.", { footer: { text: "Sent from my Ship" } }).text)
      .toBe("See you then.\n\nSent from my Ship\n");
    expect(renderMail("See you then.").html).not.toContain("Sent from my Ship");
  });

  it("quotes a reply's original below the footer in the owner's time", () => {
    const { html, text } = renderMail("Friday works.", {
      footer: FOOTER,
      quote: {
        from: "Mike <mike@example.com>",
        sentAt: Date.UTC(2026, 10, 6, 13, 5),
        timeZone: "Europe/Madrid",
        text: "Can you make Friday?\n\nMike",
      },
    });

    expect(text).toBe([
      "Friday works.",
      "",
      "Sent from my Ship (https://ship.space)",
      "",
      "On Fri, 6 Nov 2026 at 14:05, Mike <mike@example.com> wrote:",
      "",
      "> Can you make Friday?",
      ">",
      "> Mike",
      "",
    ].join("\n"));
    expect(html).toContain("On Fri, 6 Nov 2026 at 14:05, Mike &lt;mike@example.com&gt; wrote:");
    expect(html).toContain("<blockquote class=\"gmail_quote\" type=\"cite\"");
    expect(html).toContain("Can you make Friday?<br>\n<br>\nMike");
    expect(html.indexOf("Sent from my Ship")).toBeLessThan(html.indexOf("gmail_quote"));
  });
});

describe("mail footer configuration", () => {
  it("reads the operator's text and link", () => {
    expect(mailFooter({})).toBeUndefined();
    expect(mailFooter({ MAIL_FOOTER_TEXT: " Sent from my Ship " })).toEqual({ text: "Sent from my Ship" });
    expect(mailFooter({ MAIL_FOOTER_TEXT: "Sent from my Ship", MAIL_FOOTER_URL: "https://ship.space" }))
      .toEqual(FOOTER);
  });

  it.each([
    { MAIL_FOOTER_URL: "https://ship.space" },
    { MAIL_FOOTER_TEXT: "Sent from my Ship", MAIL_FOOTER_URL: "http://ship.space" },
    { MAIL_FOOTER_TEXT: "Sent from my Ship", MAIL_FOOTER_URL: "https://user:secret@ship.space" },
    { MAIL_FOOTER_TEXT: "Sent from\nmy Ship" },
  ])("refuses an invalid footer %o", (env) => {
    expect(() => mailFooter(env)).toThrow();
  });
});
