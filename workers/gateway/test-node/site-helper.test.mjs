import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SITE_BUILD_HELPER } from "../src/sites/node-helper.ts";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gsv-site-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const output = join(project, "dist");
  await mkdir(output, { recursive: true });
  await writeFile(join(root, "helper.mjs"), SITE_BUILD_HELPER);
  await writeFile(join(root, "job.json"), JSON.stringify({ base: "/_r/test-release/", manifest: { title: "Demo" }, executable: [] }));
  await writeFile(join(output, "index.html"), "<h1>Demo</h1>");
  return { root, project, output, collect: () => exec(process.execPath, [join(root, "helper.mjs"), root, "--collect-only"]) };
}

test("collects nested and binary output with hashes and writes its manifest outside public output", async t => {
  const f = await fixture(t);
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255]);
  await mkdir(join(f.output, "assets"));
  await writeFile(join(f.output, "assets", "app.wasm"), wasm);
  await f.collect();
  const manifest = JSON.parse(await readFile(join(f.root, "manifest.json"), "utf8"));
  assert.equal(manifest.title, "Demo");
  assert.deepEqual(manifest.files[0], { path: "assets/app.wasm", size: wasm.length, sha256: createHash("sha256").update(wasm).digest("hex") });
  assert.equal(manifest.files.length, 2);
  await assert.rejects(stat(join(f.output, "manifest.json")), { code: "ENOENT" });
});

test("rejects output symlinks, special files, unsafe names and oversized files before activation", async t => {
  for (const kind of ["file-link", "directory-link", "output-link", "fifo", "oversized", "unsafe-name"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      await writeFile(join(f.root, "private.txt"), "private");
      if (kind === "file-link") await symlink(join(f.root, "private.txt"), join(f.output, "secret.txt"));
      if (kind === "directory-link") await symlink(f.root, join(f.output, "outside"));
      if (kind === "output-link") {
        await rm(f.output, { recursive: true });
        await symlink(f.root, f.output);
      }
      if (kind === "fifo") await exec("mkfifo", [join(f.output, "pipe")]);
      if (kind === "oversized") {
        await writeFile(join(f.output, "large.bin"), "");
        await truncate(join(f.output, "large.bin"), 256 * 1024 * 1024 + 1);
      }
      if (kind === "unsafe-name") await writeFile(join(f.output, "bad%2fpath"), "");
      await assert.rejects(f.collect(), /symlinks|regular files|publication limits|Invalid site output path/);
      await assert.rejects(stat(join(f.root, "manifest.json")), { code: "ENOENT" });
    });
  }
});

test("runs npm with the release base and restores executable source files before building", async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, "package.json"), JSON.stringify({ name: "gsv-site-helper-test", version: "1.0.0", scripts: { build: "./build.sh" } }));
  await writeFile(join(f.project, "build.sh"), "#!/bin/sh\nprintf '%s' \"$GSV_SITE_BASE\" > dist/base.txt\n");
  await chmod(join(f.project, "build.sh"), 0o600);
  await writeFile(join(f.root, "job.json"), JSON.stringify({ base: "/_r/pinned-release/", manifest: { title: "Built" }, executable: ["build.sh"] }));
  await exec(process.execPath, [join(f.root, "helper.mjs"), f.root], { timeout: 30_000, env: { ...process.env, npm_config_registry: "http://127.0.0.1:9", npm_config_update_notifier: "false" } });
  assert.equal(await readFile(join(f.output, "base.txt"), "utf8"), "/_r/pinned-release/");
  assert.equal((await stat(join(f.project, "build.sh"))).mode & 0o777, 0o700);
  assert.ok(JSON.parse(await readFile(join(f.root, "manifest.json"), "utf8")).files.some(file => file.path === "base.txt"));
});
