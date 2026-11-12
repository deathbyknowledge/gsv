import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runtime = fileURLToPath(new URL("../../runtime", import.meta.url));

it("finds no Ship names in the runtime", () => {
  const files = readdirSync(runtime, { recursive: true, encoding: "utf8" })
    .filter(file => !file.split("/").includes("node_modules") && /\.(ts|js|json|jsonc|html|md)$/.test(file));
  expect(files.length).toBeGreaterThan(10);
  const hits = files.flatMap(file => readFileSync(join(runtime, file), "utf8").split("\n")
    .flatMap((line, index) => /\bship\b/i.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
  expect(hits).toEqual([]);
});
