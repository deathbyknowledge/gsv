import assert from "node:assert/strict";
import test from "node:test";
import { webSearchArgsSchema } from "../dist/services/web-search.js";

test("web search validates bounded queries, result counts and domains", () => {
  assert.deepEqual(webSearchArgsSchema.parse({ query: " news ", includeDomains: ["EXAMPLE.COM"] }), {
    query: "news", includeDomains: ["example.com"],
  });
  for (const value of [
    { query: "" }, { query: "x".repeat(2001) }, { query: "news", limit: 11 },
    { query: "news", includeDomains: ["https://example.com"] },
    { query: "news", installationId: "another-space" },
    { query: "news", target: "laptop" },
  ]) assert.equal(webSearchArgsSchema.safeParse(value).success, false);
});
