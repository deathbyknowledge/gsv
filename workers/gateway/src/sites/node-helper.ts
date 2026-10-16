/** Runs on the selected computer; receives paths and public build metadata, never gateway credentials. */
export const SITE_BUILD_HELPER = String.raw`
import { chmod, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.argv[2];
const job = JSON.parse(await readFile(join(root, "job.json"), "utf8"));
const project = join(root, "project");
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn("npm", args, { cwd: project, stdio: "inherit", env: { ...process.env, GSV_SITE_BASE: job.base } });
  child.once("error", reject);
  child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error("npm failed: " + (signal || code))));
});
if (!process.argv.includes("--collect-only")) {
  for (const path of job.executable) await chmod(join(project, path), 0o700);
  const locked = await lstat(join(project, "package-lock.json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  await run([locked ? "ci" : "install", "--no-audit", "--no-fund"]);
  await run(["run", "build"]);
}
const output = join(project, "dist");
const files = [];
let bytes = 0;
let entries = 0;
async function collect(directory, prefix = "") {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Site output cannot contain symlinks");
  for (const name of await readdir(directory)) {
    if (++entries > 2048) throw new Error("Site output has too many entries");
    const path = prefix ? prefix + "/" + name : name;
    if (path.length > 512 || /[\\%?#\u0000-\u001f\u007f]/.test(path) || name === "." || name === "..") throw new Error("Invalid site output path");
    const absolute = join(directory, name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("Site output cannot contain symlinks");
    if (stat.isDirectory()) { await collect(absolute, path); continue; }
    if (!stat.isFile()) throw new Error("Site output must contain only regular files");
    bytes += stat.size;
    if (files.length >= 1024 || stat.size > 256 * 1024 * 1024 || bytes > 1024 * 1024 * 1024) throw new Error("Site output exceeds publication limits");
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of createReadStream(absolute)) { read += chunk.length; if (read > stat.size) throw new Error("Site output changed during collection"); hash.update(chunk); }
    const after = await lstat(absolute);
    if (read !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !after.isFile()) throw new Error("Site output changed during collection");
    files.push({ path, size: stat.size, sha256: hash.digest("hex") });
  }
}
await collect(output);
files.sort((a, b) => a.path.localeCompare(b.path));
if (!files.some(file => file.path === "index.html")) throw new Error("Build must produce dist/index.html");
await writeFile(join(root, "manifest.json"), JSON.stringify({ ...job.manifest, files }), { flag: "wx", mode: 0o600 });
`;
