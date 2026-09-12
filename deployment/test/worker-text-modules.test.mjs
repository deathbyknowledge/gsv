import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import MagicString from "magic-string";
import { SourceMapConsumer } from "source-map-js";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { normalizeWorkerTextModules } from "../../scripts/normalize-worker-text-modules.mjs";

// Exercise the installed uploader's selection rules; this module has no public package export.
const { readPrebuiltWorkerBundle } = await import(new URL("./Cloudflare/Workers/Sources/Prebuilt.js", import.meta.resolve("alchemy")).href);

describe("prebuilt Worker text modules", () => {
  it("preserves text imports, unrelated literals and original source positions through the actual uploader and runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "gsv-worker-text-"));
    const text = "---\r\nname: fixture\r\n---\r\nOlá, 世界.\n";
    const original = 'import skill from "./hash-SKILL.md"; const marker = "./hash-SKILL.md"; export default { async fetch() { const nested = await import("./hash-SKILL.md"); return Response.json({ skill, nested: nested.default, marker, type: typeof skill }); } };';
    let runtime;
    try {
      writeFileSync(join(root, "hash-SKILL.md"), text);
      writeFileSync(join(root, "README.md"), "Bundle documentation");
      writeFileSync(join(root, "index.js"), `${original}\n//# sourceMappingURL=index.js.map\n`);
      writeFileSync(join(root, "index.js.map"), new MagicString(original).generateMap({ file: "index.js", source: "source.ts", includeContent: true, hires: true }).toString());
      const before = await Effect.runPromise(readPrebuiltWorkerBundle({ main: join(root, "index.js") }).pipe(Effect.provide(NodeServices.layer)));
      expect(before.files.map((file) => file.path)).toEqual(["index.js"]);

      expect(await normalizeWorkerTextModules(root)).toEqual({ modules: 1, entries: 1 });
      expect(readFileSync(join(root, "hash-SKILL.txt"))).toEqual(Buffer.from(text));
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("Bundle documentation");
      const normalized = readFileSync(join(root, "index.js"), "utf8");
      expect(normalized).toContain('const marker = "./hash-SKILL.md"');
      expect(normalized).toContain('import("./hash-SKILL.txt")');
      const map = new SourceMapConsumer(JSON.parse(readFileSync(join(root, "index.js.map"), "utf8")));
      expect(map.originalPositionFor({ line: 1, column: normalized.indexOf("const marker") }))
        .toMatchObject({ source: "source.ts", line: 1, column: original.indexOf("const marker") });
      const files = readdirSync(root).map((name) => [name, readFileSync(join(root, name))]);
      expect(await normalizeWorkerTextModules(root)).toEqual({ modules: 0, entries: 0 });
      expect(readdirSync(root).map((name) => [name, readFileSync(join(root, name))])).toEqual(files);

      const bundle = await Effect.runPromise(readPrebuiltWorkerBundle({ main: join(root, "index.js") }).pipe(Effect.provide(NodeServices.layer)));
      expect(bundle.files.map((file) => file.path)).toEqual(["index.js", "hash-SKILL.txt"]);
      runtime = new Miniflare({ compatibilityDate: "2026-07-29", modulesRoot: root, modules: bundle.files.map((file) => ({
        type: file.path.endsWith(".txt") ? "Text" : "ESModule", path: join(root, file.path), contents: Buffer.from(file.content).toString("utf8"),
      })) });
      expect(await (await runtime.dispatchFetch("https://fixture.invalid")).json())
        .toEqual({ skill: text, nested: text, marker: "./hash-SKILL.md", type: "string" });
    } finally {
      await runtime?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an occupied destination before altering the bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "gsv-worker-text-"));
    try {
      const entry = 'import text from "./skill.md"; export default text;';
      writeFileSync(join(root, "index.js"), entry);
      writeFileSync(join(root, "skill.md"), "source");
      writeFileSync(join(root, "skill.txt"), "existing");
      await expect(normalizeWorkerTextModules(root)).rejects.toThrow(/occupied/);
      expect(readFileSync(join(root, "index.js"), "utf8")).toBe(entry);
      expect(readFileSync(join(root, "skill.md"), "utf8")).toBe("source");
      expect(readFileSync(join(root, "skill.txt"), "utf8")).toBe("existing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
