import { describe, expect, it } from "vitest";
import { extractMessageLinks } from "./linkPreviews";

describe("message links", () => {
  it("finds markdown links, autolinks and bare URLs in order", () => {
    const text = "Read [the guide](https://guide.example/start?x=1&y=2), then <https://auto.example/a> and https://bare.example/path.";
    expect(extractMessageLinks(text)).toEqual([
      "https://guide.example/start?x=1&y=2",
      "https://auto.example/a",
      "https://bare.example/path",
    ]);
  });

  it("lists a link once, where it first appears", () => {
    expect(extractMessageLinks("https://one.example and https://two.example, again [one](https://one.example)."))
      .toEqual(["https://one.example", "https://two.example"]);
  });

  it("leaves trailing punctuation and closing brackets out of bare URLs", () => {
    expect(extractMessageLinks("(see https://docs.example/page). Or https://docs.example/q?a=b!"))
      .toEqual(["https://docs.example/page", "https://docs.example/q?a=b"]);
  });

  it("ignores URLs in inline and fenced code", () => {
    const text = "Run `curl https://inline.example` or:\n\n```\ncurl https://fenced.example\n```\n\nhttps://kept.example";
    expect(extractMessageLinks(text)).toEqual(["https://kept.example"]);
  });

  it("ignores images and links that are not on the web", () => {
    expect(extractMessageLinks("![chart](https://img.example/a.png) [mail](mailto:a@b.example) [place](#place:studio) [file](/home/notes.md)"))
      .toEqual([]);
  });

  it("finds links inside lists, quotes and tables", () => {
    const text = "- item https://list.example\n\n> quoted [q](https://quote.example)\n\n| a |\n| - |\n| https://table.example |";
    expect(extractMessageLinks(text)).toEqual(["https://list.example", "https://quote.example", "https://table.example"]);
  });
});
