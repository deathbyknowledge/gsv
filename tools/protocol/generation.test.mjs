import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const generatedPaths = [
  "workers/gateway/src/protocol/generated/wire-frame-schema.js",
  "host/crates/gateway-client/src/protocol/generated.rs",
];

test("protocol generation is stable with shared worktree dependencies", async (context) => {
  const worktree = await mkdtemp(join(tmpdir(), "gsv-protocol-worktree-"));
  context.after(() => rm(worktree, { recursive: true, force: true }));
  for (const path of ["package.json", "packages/gsv/src", "packages/gsv/tsconfig.json", "tools/protocol"]) {
    const destination = join(worktree, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repositoryRoot, path), destination, { recursive: true });
  }
  for (const path of generatedPaths) {
    await mkdir(dirname(join(worktree, path)), { recursive: true });
  }
  await symlink(await realpath(join(repositoryRoot, "node_modules")), join(worktree, "node_modules"), "junction");

  // Use the public command: ts-json-schema-generator derives names from paths
  // relative to cwd, so resolving shared dependencies outside it changes output.
  const { scripts } = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"));
  execSync(scripts["protocol:generate"], { cwd: worktree, stdio: "pipe" });

  for (const path of generatedPaths) {
    const expected = await readFile(join(repositoryRoot, path), "utf8");
    const actual = await readFile(join(worktree, path), "utf8");
    assert.ok(actual === expected, `${path} must not depend on the shared dependency path`);
  }
});
