import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

const PAGES = {
  "pages/people/maria.md": "# Maria\n\nMaria's birthday is 12 May.\nShe prefers calls to texts.\n",
  "pages/people/sofia.md": "# Sofía\n\nEl cumpleaños de Sofía es el 3 de marzo.\n",
  "pages/notes.md": "# Notes\n\nNothing about birthdays here.\n",
  "pages/trip.md": "# Trip\n\n✅ Book flights\nBook dinner → Thursday\nDeposit is €20.\nThe taxi takes 20 minutes.\n",
  "src/app.ts": "export function handleSearch() {}\nconst limit = 30;\n// The limit is 30 rows.\n",
};

describe("repository search", () => {
  let harness, worker;
  beforeAll(async () => {
    const root = resolve(import.meta.dirname, "..");
    harness = createTestHarness({ root, workers: [{ config: {
      name: "ripgit-search", main: resolve(root, "build/index.js"), compatibility_date: "2026-07-29",
      durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
    } }] });
    await harness.listen();
    worker = harness.getWorker("ripgit-search");
    const response = await worker.fetch("https://ripgit.invalid/hyperspace/repos/alice/personal/apply", {
      method: "POST", headers: { "x-gsv-installation-id": "inst_search", "content-type": "application/json" },
      body: JSON.stringify({ defaultBranch: "main", author: "alice", email: "alice@gsv.local", message: "seed",
        ops: Object.entries(PAGES).map(([path, text]) => ({
          type: "put", path, contentBytes: [...new TextEncoder().encode(text)],
        })) }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });
  afterAll(async () => { await harness?.close(); });

  async function search(query) {
    const url = new URL("https://ripgit.invalid/hyperspace/repos/alice/personal/search");
    url.searchParams.set("query", query);
    const response = await worker.fetch(url, { headers: { "x-gsv-installation-id": "inst_search" } });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).matches;
  }

  it.each([
    ["birthday", ["pages/people/maria.md:3"]],
    ["birthday is", ["pages/people/maria.md:3"]],
    ["Maria's birthday", ["pages/people/maria.md:3"]],
    ["maria birthday", ["pages/people/maria.md:1", "pages/people/maria.md:3"]],
    ["calls texts", ["pages/people/maria.md:4"]],
    ["birth*", ["pages/notes.md:3", "pages/people/maria.md:3"]],
    ["\"calls to texts\"", ["pages/people/maria.md:4"]],
    ["maria's birthday", ["pages/people/maria.md:3"]],
    ["birthday maria's", ["pages/people/maria.md:3"]],
    ["cumpleaños sofía", ["pages/people/sofia.md:1", "pages/people/sofia.md:3"]],
    ["sofia", ["pages/people/sofia.md:1", "pages/people/sofia.md:3"]],
    ["handlesearch()", ["src/app.ts:1"]],
    ["✅", ["pages/trip.md:3"]],
    ["→", ["pages/trip.md:4"]],
    ["€20", ["pages/trip.md:5"]],
    ["✅ book", ["pages/trip.md:3"]],
    ["limit = 30", ["src/app.ts:2"]],
  ])("finds the lines for %s", async (query, expected) => {
    const matches = await search(query);
    expect(matches.map((match) => `${match.path}:${match.line}`).sort()).toEqual(expected);
    for (const match of matches) {
      expect(match.content).toBe(PAGES[match.path].split("\n")[match.line - 1]);
    }
  });
});
