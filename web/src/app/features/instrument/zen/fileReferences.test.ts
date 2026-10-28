import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { fileReferenceHref, fileReferenceRow, filePathLinks, textLinkRow } from "./fileReferences";

const marked = new Marked(filePathLinks);
/** The parser ZenText uses for Ship's text, before DOMPurify, which needs a DOM these tests do not have. */
function html(text: string): string {
  return marked.parse(text, { async: false, breaks: true, gfm: true }).trim();
}
const link = (path: string) => `<a href="${fileReferenceHref(path)}">${path}</a>`;

describe("file paths in Ship's text", () => {
  it("links an absolute file and a home folder", () => {
    expect(html("Saved in /home/friday/lease/rent-deposit/ with a summary."))
      .toBe(`<p>Saved in ${link("/home/friday/lease/rent-deposit/")} with a summary.</p>`);
    expect(html("Read /home/x/y.md first")).toBe(`<p>Read ${link("/home/x/y.md")} first</p>`);
    expect(html("Your notes live in ~/notes/")).toBe(`<p>Your notes live in ${link("~/notes/")}</p>`);
    expect(html("/tmp/report.csv is ready")).toBe(`<p>${link("/tmp/report.csv")} is ready</p>`);
    expect(html("Kept in (~/notes/résumé.md)")).toBe(`<p>Kept in (${link("~/notes/résumé.md")})</p>`);
  });

  it("leaves sentence punctuation and closing brackets outside the link", () => {
    expect(html("It is /home/x/y.md.")).toBe(`<p>It is ${link("/home/x/y.md")}.</p>`);
    expect(html("Both /home/x/a.md, /home/x/b.md; done")).toBe(`<p>Both ${link("/home/x/a.md")}, ${link("/home/x/b.md")}; done</p>`);
    expect(html("(see /home/x/y.md)")).toBe(`<p>(see ${link("/home/x/y.md")})</p>`);
    expect(html("(/workspace/app/notes_(old).md)")).toBe(`<p>(${link("/workspace/app/notes_(old).md")})</p>`);
  });

  it("keeps code spans, code blocks and written links as they are", () => {
    expect(html("Run `cat /home/x/y.md` now")).toBe("<p>Run <code>cat /home/x/y.md</code> now</p>");
    expect(html("```\nls /home/x/\n```")).toBe("<pre><code>ls /home/x/\n</code></pre>");
    expect(html("[the notes /home/x/y.md](https://example.com)")).toBe('<p><a href="https://example.com">the notes /home/x/y.md</a></p>');
    expect(html("See https://example.com/home/x/y")).toBe('<p>See <a href="https://example.com/home/x/y">https://example.com/home/x/y</a></p>');
  });

  it("does not read words, API routes or other roots as paths", () => {
    expect(html("and/or")).toBe("<p>and/or</p>");
    expect(html("call /v1/users and /etc/hosts")).toBe("<p>call /v1/users and /etc/hosts</p>");
    expect(html("x/home/y and /homework/z")).toBe("<p>x/home/y and /homework/z</p>");
  });

  it("links a path inside emphasis and after a line break", () => {
    expect(html("**/home/x/y.md**")).toBe(`<p><strong>${link("/home/x/y.md")}</strong></p>`);
    expect(html("Files:\n/home/x/y.md")).toBe(`<p>Files:<br>${link("/home/x/y.md")}</p>`);
  });
});

describe("file reference links", () => {
  it("opens a file, and a trailing slash opens the folder", () => {
    expect(fileReferenceRow(fileReferenceHref("/home/x/y z.md"))).toBe("file:gsv:/home/x/y z.md");
    expect(fileReferenceRow(fileReferenceHref("/home/x/lease/"))).toBe("dir:gsv:/home/x/lease");
    expect(fileReferenceRow(fileReferenceHref("~/"))).toBe("dir:gsv:~");
    expect(fileReferenceRow(fileReferenceHref("~/Año 2026/日本 #1?.md"))).toBe("file:gsv:~/Año 2026/日本 #1?.md");
  });

  it("ignores other links and malformed ones", () => {
    expect(fileReferenceRow("#place:laptop")).toBeNull();
    expect(fileReferenceRow("https://example.com/#file:gsv:/x")).toBeNull();
    expect(fileReferenceRow("#file:gsv:%E0")).toBeNull();
  });
});

describe("links clicked in Ship's text", () => {
  it("opens a mentioned place, a linked file or folder in Work, and leaves other links to the browser", () => {
    expect(textLinkRow("#place:laptop%201")).toBe("target:laptop 1");
    expect(textLinkRow(fileReferenceHref("/home/x/notes.md"))).toBe("file:gsv:/home/x/notes.md");
    expect(textLinkRow(fileReferenceHref("~/notes/"))).toBe("dir:gsv:~/notes");
    expect(textLinkRow("https://example.com/home/x")).toBeNull();
    expect(textLinkRow("#section")).toBeNull();
    expect(textLinkRow("#place:%E0")).toBeNull();
  });
});
