import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { get } from "node:http";
import {
  createSourceReviewServer,
  createWorkspaceRegistry,
  listWorkspaceFiles,
  REPO_ROOT,
  resolveWorkspacePath,
} from "./server.mjs";
import { loadPromptPreview } from "./prompt-loader.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("source paths stay inside their declared workspace and only expose Markdown", async () => {
  const workspace = createWorkspaceRegistry().get("prompts");
  assert.equal((await resolveWorkspacePath(workspace, "role-and-judgment/ship.md")).relativePath, "role-and-judgment/ship.md");
  await assert.rejects(resolveWorkspacePath(workspace, "../process/do.ts"), /outside/);
  await assert.rejects(resolveWorkspacePath(workspace, "system.ts"), /file type/);
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

test("previews assemble account-specific defaults with the runtime providers", async () => {
  const [ship, crew] = await Promise.all([loadPromptPreview("ship"), loadPromptPreview("crew")]);
  assert.match(ship.prompt, /<system path="\/sys\/config\/ai\/context.d\/">/);
  assert.match(ship.prompt, /<program path="\/home\/ship\/context.d\/">/);
  assert.match(ship.prompt, /<05-voice.md>/);
  assert.match(ship.prompt, /Crew account: `crew`/);
  assert.doesNotMatch(crew.prompt, /<05-voice.md>/);
  assert.match(crew.prompt, /<program path="\/home\/crew\/context.d\/">/);
  for (const preview of [ship, crew]) {
    assert.match(preview.prompt, /<user path="\/home\/alex\/context.d\/">/);
    assert.match(preview.prompt, /<available_skills>/);
    assert.doesNotMatch(preview.prompt, /\{\{/);
    assert.equal(preview.sources.length, preview.sections.length);
    assert.ok(preview.sources.some((source) => source.responsibilityBaseline));
    assert.ok(preview.sources.every((source) => source.sha256.length === 64));
  }
  const files = await listWorkspaceFiles(createWorkspaceRegistry().get("prompts"));
  assert.deepEqual(ship.catalog.map((source) => source.path).sort(), files.map((file) => file.path).sort());
  for (const preview of [ship, crew]) {
    const paths = new Set(preview.sections.flatMap((section) => section.paths));
    for (const source of preview.catalog) {
      const applies = ["shared", "owner", preview === ship ? "ship" : "crew", ...(preview === crew ? ["agent"] : [])].includes(source.scope);
      assert.equal(paths.has(source.path), applies, source.path);
    }
  }
});

test("unsaved Markdown changes the real assembled prompt without touching disk or leaking into the next preview", async () => {
  const absolutePath = join(REPO_ROOT, "workers/gateway/src/prompts/instance-facts/runtime.md");
  const original = await readFile(absolutePath, "utf8");
  const preview = await loadPromptPreview("ship", {
    absolutePath, content: "# Edited\n\nHello {{program.username}} from {{user.username}}.\nLiteral `code` and ${notJavaScript}.\n",
  });
  assert.match(preview.prompt, /Hello ship from alex\./);
  assert.match(preview.prompt, /Literal `code` and \$\{notJavaScript\}/);
  assert.equal(await readFile(absolutePath, "utf8"), original);
  assert.doesNotMatch((await loadPromptPreview("ship")).prompt, /# Edited/);
  const blank = await loadPromptPreview("ship", { absolutePath, content: "" });
  assert.ok(!blank.sections.some((section) => section.name === "00-runtime.md"));
});

test("each category draft reaches its intended accounts without changing another account's instructions", async () => {
  const sources = (await loadPromptPreview("ship")).catalog;
  for (const source of sources) {
    const marker = `Category draft for ${source.path}`;
    const absolutePath = join(REPO_ROOT, "workers/gateway/src/prompts", source.path);
    const original = await readFile(absolutePath, "utf8");
    for (const account of ["ship", "crew"]) {
      const preview = await loadPromptPreview(account, { absolutePath, content: marker });
      const applies = source.scope === "shared" || source.scope === "owner" || source.scope === account
        || (source.scope === "agent" && account === "crew");
      assert.equal(preview.prompt.includes(marker), applies, `${source.path} in ${account}`);
      assert.equal(preview.catalog.find((entry) => entry.path === source.path).text, marker);
    }
    assert.equal(await readFile(absolutePath, "utf8"), original);
  }
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

test("the preview API validates drafts and renders their Markdown", async (context) => {
  const server = createSourceReviewServer();
  context.after(() => server.close());
  const origin = await listen(server);
  const post = (body) => fetch(`${origin}/api/prompt-preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await post({ account: "crew", draft: { path: "role-and-judgment/crew.md", content: "# Draft\n\nDo **this**." } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.prompt, /Do \*\*this\*\*/);
  assert.ok(data.sections.some((section) => section.html.includes("<strong>this</strong>")));
  assert.equal((await post({ account: "root" })).status, 400);
  assert.equal((await post({ account: "crew", draft: { path: "../../private.md", content: "bad" } })).status, 403);
  assert.equal((await post({ account: "crew", draft: { path: "personal-intelligence.ts", content: "bad" } })).status, 415);
  const rejectedHost = await new Promise((resolve, reject) => {
    get(`${origin}/api/config`, { headers: { host: "attacker.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch(`${origin}/api/prompt-preview`, {
    method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify({ account: "crew" }),
  })).status, 403);
});

test("simultaneous saves preserve the first edit and return a conflict for the second", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "gsv-prompt-write-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "prompt.md"), "original\n");
  const server = createSourceReviewServer({
    workspaces: new Map([["prompts", { id: "prompts", root, extensions: new Set([".md"]) }]]),
  });
  context.after(() => server.close());
  const origin = await listen(server);
  const loaded = await fetch(`${origin}/api/file?workspace=prompts&path=prompt.md`).then((response) => response.json());
  const responses = await Promise.all(["first", "second"].map((content) => fetch(`${origin}/api/file`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: "prompts", path: "prompt.md", content, expectedHash: loaded.hash }),
  })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(await readFile(join(root, "prompt.md"), "utf8"), responses[0].ok ? "first" : "second");
});

test("source files cannot follow symlinks out of the workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "gsv-source-links-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "prompts"));
  await writeFile(join(root, "outside.md"), "outside\n");
  await symlink(join(root, "outside.md"), join(root, "prompts", "linked.md"));
  await assert.rejects(resolveWorkspacePath({ root: join(root, "prompts"), extensions: new Set([".md"]) }, "linked.md"), /outside/);
});
