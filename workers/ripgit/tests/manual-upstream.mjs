import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export async function manualUpstream() {
  const directory = await mkdtemp(join(tmpdir(), "gsv-manual-upstream-"));
  const run = async (...args) => (await promisify(execFile)("git", ["-C", directory, ...args])).stdout.trim();
  await run("init", "-q", "-b", "main");
  await run("config", "user.name", "Manual fixture");
  await run("config", "user.email", "manual@example.invalid");
  await run("config", "uploadpack.allowReachableSHA1InWant", "true");
  await writeFile(join(directory, "wiki.json"), JSON.stringify({ kind: "gsv.wiki", version: 1, id: "gsv-manual", title: "GSV Manual" }));
  const revisions = [];
  for (const version of [1, 2, 3]) {
    await writeFile(join(directory, "index.md"), `Manual version ${version}\n`);
    await run("add", ".");
    await run("commit", "-qm", `manual ${version}`);
    revisions.push(await run("rev-parse", "HEAD"));
  }
  let fetches = 0;
  let fail = false;
  let hold;
  const server = createServer(async (request, response) => {
    const isUpload = request.method === "POST";
    if (isUpload) {
      fetches++;
      if (hold) await hold();
    }
    if (fail) { response.writeHead(503); response.end("Unavailable"); return; }
    response.setHeader("content-type", isUpload ? "application/x-git-upload-pack-result" : "application/x-git-upload-pack-advertisement");
    if (!isUpload) response.write("001e# service=git-upload-pack\n0000");
    const child = spawn("git", ["upload-pack", "--stateless-rpc", ...(!isUpload ? ["--advertise-refs"] : []), directory]);
    if (isUpload) request.pipe(child.stdin); else child.stdin.end();
    child.stdout.pipe(response);
    child.stderr.resume();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/manual.git`, revisions,
    get fetches() { return fetches; },
    set fail(value) { fail = value; },
    holdNext() {
      let release, entered;
      const started = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      hold = async () => { hold = undefined; entered(); await gate; };
      return { started, release };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
