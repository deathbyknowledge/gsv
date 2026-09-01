import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSourceReviewServer,
  createWorkspaceRegistry,
  listWorkspaceFiles,
  loadPromptGroups,
  REPO_ROOT,
  resolveWorkspacePath,
} from "./server.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("source paths stay inside their declared workspace", () => {
  const workspace = createWorkspaceRegistry().get("prompts");
  assert.equal(resolveWorkspacePath(workspace, "system.ts").relativePath, "system.ts");
  assert.throws(() => resolveWorkspacePath(workspace, "../process/do.ts"), /outside/);
  assert.throws(() => resolveWorkspacePath(workspace, "system.md"), /file type/);
});

test("workspace listing includes allowed files and skips repository metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsv-source-review-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "pages"));
  await writeFile(join(root, "index.md"), "# Index\n");
  await writeFile(join(root, "wiki.json"), "{}\n");
  await writeFile(join(root, ".git", "secret.md"), "hidden\n");
  await writeFile(join(root, "pages", "guide.md"), "# Guide\n");
  await writeFile(join(root, "pages", "ignored.txt"), "ignored\n");
  const workspace = {
    id: "manual",
    label: "Manual",
    root,
    extensions: new Set([".md", ".json"]),
  };
  const files = await listWorkspaceFiles(workspace);
  assert.deepEqual(files.map((file) => file.path), ["index.md", "pages/guide.md", "wiki.json"]);
});

test("prompt review evaluates current source exports", async () => {
  const result = await loadPromptGroups(join(REPO_ROOT, "workers/gateway/src/prompts"));
  assert.ok(result.blocks.some((block) => block.exportName === "GSV_RUNTIME_CONTEXT"));
  assert.ok(result.blocks.some((block) => block.exportName === "PERSONAL_INTELLIGENCE_CONTEXT"));
  assert.ok(result.blocks.every((block) => !block.exportName.startsWith("LEGACY_")));
  assert.ok(result.bytes > 0);
  assert.equal(result.estimatedTokens, Math.ceil(result.bytes / 4));
});

test("source writes reject a stale editor before changing the worktree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "gsv-source-write-"));
  const path = join(root, "index.md");
  await writeFile(path, "first\n");
  const workspace = {
    id: "manual",
    label: "Manual",
    root,
    extensions: new Set([".md"]),
  };
  const server = createSourceReviewServer({
    initialWorkspace: "manual",
    workspaces: new Map([["manual", workspace]]),
  });
  context.after(() => server.close());
  const origin = await listen(server);
  const loaded = await fetch(`${origin}/api/file?workspace=manual&path=index.md`).then((response) => response.json());
  await writeFile(path, "external\n");
  const response = await fetch(`${origin}/api/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace: "manual",
      path: "index.md",
      content: "editor\n",
      expectedHash: loaded.hash,
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(await readFile(path, "utf8"), "external\n");
});
