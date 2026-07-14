import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("production gateway routes health checks to the Worker before SPA assets", () => {
  const configPath = fileURLToPath(new URL("../../../gateway/wrangler.jsonc", import.meta.url));
  const config = readFileSync(configPath, "utf8");
  const routesBlock = /"run_worker_first"\s*:\s*\[([\s\S]*?)\]/.exec(config)?.[1];
  assert.ok(routesBlock, "gateway assets.run_worker_first must be configured");
  const routes = [...routesBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(routes.includes("/health"), "gateway assets.run_worker_first must include /health");
});
