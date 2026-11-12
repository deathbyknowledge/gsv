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
import { diffLines, unifiedHunks } from "./line-diff.mjs";

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
  assert.equal((await resolveWorkspacePath(workspace, "ship/context.d/00-role.md")).relativePath, "ship/context.d/00-role.md");
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
  assert.doesNotMatch(crew.prompt, /<00-style.md>/);
  assert.match(crew.prompt, /<program path="\/home\/crew\/context.d\/">/);
  for (const preview of [ship, crew]) {
    assert.match(preview.prompt, /<user path="\/home\/alex\/context.d\/">/);
    assert.match(preview.prompt, /<available_skills>/);
    assert.doesNotMatch(preview.prompt, /\{\{/);
    assert.equal(preview.sources.length, preview.sections.length);
    assert.ok(preview.sources.some((source) => source.responsibilityBaseline));
    assert.ok(preview.sources.every((source) => source.sha256.length === 64));
    assert.equal(preview.prompt.split("# Knowledge").length - 1, 1);
    assert.equal(preview.sections.find((section) => section.name === "15-memory.md")?.provider, "system.context");
    for (const section of preview.sections.filter((section) => section.contextRoot)) {
      assert.equal(section.paths.length, 1);
      assert.ok(section.paths[0].endsWith(`/context.d/${section.name}`));
    }
  }
  const files = await listWorkspaceFiles(createWorkspaceRegistry().get("prompts"));
  assert.deepEqual(ship.catalog.map((source) => source.path).sort(), files.map((file) => file.path).sort());
  for (const preview of [ship, crew]) {
    const paths = new Set(preview.sections.flatMap((section) => section.paths));
    for (const source of preview.catalog) {
      const applies = ["shared", "owner", preview === ship ? "ship" : "crew"].includes(source.scope);
      assert.equal(paths.has(source.path), applies, source.path);
    }
  }
});

test("unsaved Markdown changes the real assembled prompt without touching disk or leaking into the next preview", async () => {
  const absolutePath = join(REPO_ROOT, "workers/gateway/src/prompts/system/context.d/00-runtime.md");
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
      const applies = source.scope === "shared" || source.scope === "owner" || source.scope === account;
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
  const response = await post({ account: "crew", draft: { path: "crew/context.d/00-role.md", content: "# Draft\n\nDo **this**." } });
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

test("line diffs keep unchanged context and merge nearby changes", () => {
  assert.deepEqual(diffLines("a\nb\nc\n", "a\nc\nd\n").map(({ kind, text }) => `${kind}:${text}`),
    ["same:a", "del:b", "same:c", "add:d"]);
  assert.deepEqual(unifiedHunks("same\n", "same\n"), { added: 0, removed: 0, hunks: [] });
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const after = before.replace("line 2\n", "line two\n").replace("line 4\n", "").replace("line 18", "line eighteen");
  const { added, removed, hunks } = unifiedHunks(before, after, 2);
  assert.deepEqual([added, removed], [2, 3]);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].oldStart, hunks[0].newStart], [1, 1]);
  assert.deepEqual([hunks[1].oldStart, hunks[1].newStart], [16, 15]);
  assert.deepEqual(unifiedHunks("", "new\n").hunks[0].lines, [{ kind: "add", text: "new" }]);
});

test("the context draft renders its own standing files and diffs them against the repository", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "gsv-context-draft-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["system/context.d", "ship/context.d", "crew/context.d", "moved"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const runtime = await readFile(join(REPO_ROOT, "workers/gateway/src/prompts/system/context.d/00-runtime.md"), "utf8");
  await writeFile(join(root, "system/context.d/00-runtime.md"), runtime);
  await writeFile(join(root, "ship/context.d/00-role.md"), "# Draft Ship\n\nShip at {{ship.address}}.\n");
  await writeFile(join(root, "crew/context.d/00-role.md"), "# Draft Crew\n");
  await writeFile(join(root, "moved/note.md"), "Moved out of standing context.\n");
  await writeFile(join(root, "NOTES.md"), "Notes stay out of the prompt.\n");
  const registry = createWorkspaceRegistry();
  assert.match(registry.get("context").root, /design\/context-2\.0$/);
  registry.set("context", { ...registry.get("context"), root });
  const server = createSourceReviewServer({ initialWorkspace: "context", workspaces: registry });
  context.after(() => server.close());
  const origin = await listen(server);
  const post = (path, body) => fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const ship = await post("/api/context-preview", { account: "ship" }).then((response) => response.json());
  assert.match(ship.draft.prompt, /Ship at https:\/\/preview\.ship\.space\./);
  assert.doesNotMatch(ship.draft.prompt, /Draft Crew|Moved out|Notes stay|\{\{/);
  assert.doesNotMatch(ship.draft.prompt, /<user path=/);
  assert.ok(ship.draft.sections.some((section) => section.html.includes("<h1>Draft Ship</h1>")));
  assert.ok(ship.baseline.bytes > ship.draft.bytes);
  assert.ok(ship.baseline.standingBytes > ship.draft.standingBytes);
  assert.ok(ship.diff.removed > 0 && ship.diff.added > 0);
  assert.ok(ship.diff.hunks.flatMap((hunk) => hunk.lines).some((line) => line.kind === "add" && line.text === "# Draft Ship"));

  const unsaved = await post("/api/context-preview", {
    account: "crew", draft: { path: "crew/context.d/00-role.md", content: "# Unsaved Crew\n" },
  }).then((response) => response.json());
  assert.match(unsaved.draft.prompt, /# Unsaved Crew/);
  assert.doesNotMatch(unsaved.draft.prompt, /Draft Ship/);
  assert.equal(await readFile(join(root, "crew/context.d/00-role.md"), "utf8"), "# Draft Crew\n");

  const same = await post("/api/context-file-diff", { path: "system/context.d/00-runtime.md", content: runtime })
    .then((response) => response.json());
  assert.equal(same.baselinePath, "workers/gateway/src/prompts/system/context.d/00-runtime.md");
  assert.deepEqual([same.added, same.removed, same.hunks.length], [0, 0, 0]);
  const edited = await post("/api/context-file-diff", {
    path: "system/context.d/00-runtime.md", content: runtime.replace("# Initial runtime facts", "# Runtime"),
  }).then((response) => response.json());
  assert.deepEqual([edited.added, edited.removed], [1, 1]);
  const moved = await post("/api/context-file-diff", { path: "moved/note.md", content: "Moved.\n" })
    .then((response) => response.json());
  assert.deepEqual([moved.baselinePath, moved.baseline, moved.added], [undefined, null, 1]);
  assert.equal((await post("/api/context-file-diff", { path: "../../package.json", content: "" })).status, 403);
  assert.equal((await post("/api/context-preview", {
    account: "ship", draft: { path: "../prompts/system/context.d/00-runtime.md", content: "bad" },
  })).status, 403);
});
