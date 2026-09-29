import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_PRIVATE_REVISION, LEGACY_PUBLIC_REVISION, upgradeFixtureSchema } from "./plan.ts";

process.umask(0o077);
const [file, phase] = process.argv.slice(2);
if (!file || (phase !== "legacy" && phase !== "current")) throw new Error("Usage: node build.ts /secure/fixture.json legacy|current");
const input = upgradeFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const privateRevision = phase === "legacy" ? LEGACY_PRIVATE_REVISION : input.currentPrivateRevision;
const publicRevision = phase === "legacy" ? LEGACY_PUBLIC_REVISION : input.currentPublicRevision;
const sources = join(input.artifactsDirectory, "sources", phase);
const services = join(sources, "services");
const publicRoot = join(services, "gsv");
const output = join(input.artifactsDirectory, phase);
mkdirSync(sources, { recursive: true, mode: 0o700 });
mkdirSync(output, { recursive: true, mode: 0o700 });
// An interrupted rebuild must never leave a receipt authorizing stale output.
rmSync(join(output, "receipt.json"), { force: true });
for (const directory of ["accounts", "inference", "gateway", "ripgit", "web", "migrations"]) {
  rmSync(join(output, directory), { recursive: true, force: true });
}
const log = openSync(join(output, "build.log"), "a", 0o600);
const buildEnv: NodeJS.ProcessEnv = { ...process.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1", CI: "true" };
delete buildEnv.CLOUDFLARE_API_TOKEN;
delete buildEnv.CLOUDFLARE_ACCOUNT_ID;
delete buildEnv.ESBUILD_BINARY_PATH;
const git = (repository: string, ...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
const run = (cwd: string, executable: string, args: string[]) => execFileSync(executable, args, { cwd, env: buildEnv, stdio: ["ignore", log, log] });
if (!existsSync(join(services, ".git"))) run(input.privateRepository, "git", ["worktree", "add", "--detach", services, privateRevision]);
if (git(services, "rev-parse", "HEAD") !== privateRevision) throw new Error("Private source revision does not match the fixture");
const gitlink = git(services, "rev-parse", `${privateRevision}:gsv`);
if (gitlink !== publicRevision) throw new Error("Current private and public pins must match, including the private nested SDK");
if (!existsSync(join(publicRoot, ".git"))) {
  // The checked-out gitlink is initially an empty directory.
  if (existsSync(publicRoot) && readdirSync(publicRoot).length !== 0) throw new Error("Nested source path is not empty");
  if (existsSync(publicRoot)) rmSync(publicRoot, { recursive: true });
  run(input.publicRepository, "git", ["clone", "--shared", "--no-checkout", input.publicRepository, publicRoot]);
  run(publicRoot, "git", ["checkout", "--detach", publicRevision]);
}
if (git(publicRoot, "rev-parse", "HEAD") !== publicRevision) throw new Error("Public source revision does not match the fixture");
for (const repository of [services, publicRoot]) {
  if (git(repository, "status", "--porcelain", "--untracked-files=no")) throw new Error("Refusing to build modified historical sources");
}
// The private lock installs the SDK's esbuild below its nested public checkout.
// Install it before the public root: otherwise Node finds the public native
// binary (0.28) while validating the private SDK's pinned esbuild (0.27).
rmSync(join(publicRoot, "node_modules"), { recursive: true, force: true });
run(services, "npm", ["ci"]);
run(publicRoot, "npm", ["ci"]);
run(publicRoot, "npm", ["run", "build", "--workspace", "web"]);
run(join(publicRoot, "workers/ripgit"), "npm", ["ci", "--workspaces=false"]);
run(join(publicRoot, "workers/ripgit"), "npm", ["run", "build:worker"]);
cpSync(join(publicRoot, "web/dist"), join(output, "web"), { recursive: true });
cpSync(join(publicRoot, "workers/ripgit/build"), join(output, "ripgit"), { recursive: true });
cpSync(join(services, "accounts/migrations"), join(output, "migrations"), { recursive: true });

const helper = resolve(dirname(fileURLToPath(import.meta.url)), "fixture-admin.ts");
const wrapper = join(output, "accounts-source/index.ts");
mkdirSync(dirname(wrapper), { recursive: true, mode: 0o700 });
writeFileSync(wrapper, `import Accounts from ${JSON.stringify(join(services, "accounts/src/index.ts"))};
export * from ${JSON.stringify(join(services, "accounts/src/index.ts"))};
import { fixtureAdminRequest, type FixtureAdminEnvironment } from ${JSON.stringify(helper)};
export default class FixtureAccounts extends Accounts {
  async fetch(request: Request): Promise<Response> {
    // SAFETY: the isolated composition declares these two fixture-only bindings.
    const env = this.env as typeof this.env & FixtureAdminEnvironment;
    const forwarded = await fixtureAdminRequest(request, env);
    return forwarded instanceof Response ? forwarded : super.fetch(forwarded);
  }
}
`, { mode: 0o600 });
const config = join(output, "accounts-build.json");
writeFileSync(config, JSON.stringify({ name: "build-only-upgrade-accounts", main: wrapper, compatibility_date: "2026-07-29",
  compatibility_flags: ["nodejs_compat"], workers_dev: false }, null, 2), { mode: 0o600 });
run(services, "npm", ["exec", "--workspaces=false", "--", "wrangler", "deploy", "--dry-run", "--minify", "--config", config, "--outdir", join(output, "accounts")]);
run(join(services, "inference"), "npm", ["exec", "--workspaces=false", "--", "wrangler", "deploy", "--dry-run", "--minify", "--outdir", join(output, "inference")]);
run(join(publicRoot, "workers/gateway"), "npm", ["exec", "--workspaces=false", "--", "wrangler", "deploy", "--dry-run", "--minify", "--config", "wrangler.managed.jsonc", "--outdir", join(output, "gateway"), "--define", `__GSV_RELEASE__:${JSON.stringify(publicRevision)}`]);
const gatewayMain = join(output, "gateway/index.js");
let entry = readFileSync(gatewayMain, "utf8");
for (const name of readdirSync(join(output, "gateway"))) {
  if (!name.endsWith(".md")) continue;
  const next = `${name.slice(0, -3)}.txt`;
  renameSync(join(output, "gateway", name), join(output, "gateway", next));
  entry = entry.replaceAll(`./${name}`, `./${next}`);
}
writeFileSync(gatewayMain, entry, { mode: 0o600 });
const hashes: Record<string, string> = {};
function capture(directory: string): void {
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) capture(path);
    else hashes[path.slice(output.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
}
for (const directory of ["accounts", "inference", "gateway", "ripgit", "web", "migrations"]) capture(join(output, directory));
writeFileSync(join(output, "receipt.json"), JSON.stringify({ phase, privateRevision, publicRevision,
  adminWrapperSha256: createHash("sha256").update(readFileSync(wrapper)).digest("hex"),
  adminHelperSha256: createHash("sha256").update(readFileSync(helper)).digest("hex"), hashes,
  authCoverage: "synthetic operator transport; unchanged historical account and runtime code", adapterCoverage: "none" }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ phase, publicRevision, privateRevision, moduleCount: Object.keys(hashes).length, receipt: join(output, "receipt.json") }));
