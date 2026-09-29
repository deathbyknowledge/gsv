import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GsvClientError } from "@humansandmachines/gsv/client";
import { LEGACY_PUBLIC_REVISION, upgradeFixturePlan, upgradeFixtureSchema } from "./plan.ts";
import { assertUpgradeBuildReceipt } from "./receipt.ts";
import { readPrivateState, writePrivateState } from "./private-state.ts";
import { createFixtureClient as client } from "./fixture-client.ts";

process.umask(0o077);
const [file, command, authorization] = process.argv.slice(2);
if (!file || !["seed", "reset-legacy", "verify-legacy", "verify-current"].includes(command ?? "") || authorization !== "--owned-fixtures-only") {
  throw new Error("Usage: node driver.ts /secure/fixture.json seed|reset-legacy|verify-legacy|verify-current --owned-fixtures-only");
}
const input = upgradeFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const plan = upgradeFixturePlan(input);
assertUpgradeBuildReceipt(input, command === "verify-current" ? "current" : "legacy");
const secret = process.env.GSV_UPGRADE_ADMIN_SECRET;
if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("A private fixture admin secret is required");
const stateFile = join(input.artifactsDirectory, "credentials.json");
const credentialSchema = z.object({ tokenId: z.string(), token: z.string(), kind: z.enum(["human", "machine"]), peerId: z.string().nullable() });
const spaceSchema = z.object({ handle: z.string(), operationId: z.string(), username: z.literal("upgrade"), password: z.string(), rootPassword: z.string(),
  marker: z.string(), installationId: z.string().optional(), onboardingToken: z.string().optional(), setupAttempted: z.boolean().default(false), setupComplete: z.boolean().default(false),
  credentials: z.record(z.string(), credentialSchema).default({}), pendingCredential: z.string().optional(),
  pid: z.string().optional(), conversationId: z.string().optional() });
type Space = z.infer<typeof spaceSchema>;
const stateSchema = z.object({ fixtureId: z.string(), spaces: z.array(spaceSchema),
  reset: z.object({ operationId: z.string(), previous: spaceSchema, replacementId: z.string().optional() }).optional() });
const state = existsSync(stateFile) ? stateSchema.parse(JSON.parse(readPrivateState(stateFile))) : { fixtureId: input.fixtureId, spaces: [] };
if (state.fixtureId !== input.fixtureId || state.spaces.some((space) => !plan.handles.includes(space.handle))) throw new Error("Credential evidence belongs to another fixture");
const save = () => writePrivateState(stateFile, JSON.stringify(state, null, 2));
const checks: string[] = [];
const report = { command, fixtureId: input.fixtureId, checks, authCoverage: plan.authCoverage, adapterCoverage: plan.adapterCoverage,
  explicitMessagesSent: 0, startedAt: new Date().toISOString() };
const check = (value: boolean, label: string) => { if (!value) throw new Error(label); report.checks.push(label); };
const issuedSchema = z.object({ installation: z.object({ installationId: z.string(), handle: z.string(), canonicalOrigin: z.string() }),
  onboarding: z.object({ onboardingUrl: z.string() }), reset: z.object({ previousInstallationId: z.string(), dataDeletionState: z.string() }).optional() });
const detailSchema = z.object({ installationId: z.string(), handle: z.string(), canonicalOrigin: z.string(), state: z.string(),
  reset: z.object({ previousInstallationId: z.string(), dataDeletionState: z.string() }).nullable() });
const processListSchema = z.object({ processes: z.array(z.object({ pid: z.string(), personal: z.boolean().optional(), interactive: z.boolean().optional() })) });
type AdminMutation = { operationId: string; handle: string } | { operationId: string; confirmHandle: string };
async function admin<T>(path: string, schema: z.ZodType<T>, body?: AdminMutation): Promise<T> {
  const response = await fetch(plan.adminOrigin + path, { method: body ? "POST" : "GET", redirect: "manual",
    headers: { authorization: `Bearer ${secret}`, origin: plan.adminOrigin, "content-type": "application/json", "user-agent": "gsv-upgrade-acceptance/1.0" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Fixture administration failed with HTTP ${response.status}`); }
  return schema.parse(await response.json());
}
const origin = (space: Space) => `https://${space.handle}.${input.domain}`;
const socketUrl = (space: Space) => `wss://${space.handle}.${input.domain}/ws`;
async function passwordLogin(space: Space, root = false) {
  const session = client();
  try {
    const result = await session.connect({ url: socketUrl(space), username: root ? "root" : space.username, password: root ? space.rootPassword : space.password });
    const expected = command === "verify-current" ? input.currentPublicRevision : LEGACY_PUBLIC_REVISION;
    check(result.server.release === expected, `${space.handle}: exact expected gateway release`);
    return session;
  } catch (error) { session.disconnect(); throw error; }
}
function newSpace(handle: string): Space {
  return { handle, operationId: `upgrade_${randomUUID()}`, username: "upgrade", password: randomBytes(32).toString("hex"), rootPassword: randomBytes(32).toString("hex"),
    marker: `upgrade-proof-${randomBytes(16).toString("hex")}`, setupAttempted: false, setupComplete: false, credentials: {} };
}
async function setup(space: Space): Promise<void> {
  if (!space.installationId || !space.onboardingToken) throw new Error("Missing owned onboarding receipt");
  if (space.setupComplete) return;
  // An uncertain successful setup is reconciled using credentials persisted before admission.
  let recovered = false;
  if (space.setupAttempted) {
    try { const session = await passwordLogin(space); session.disconnect(); recovered = true; }
    catch (error) { if (!(error instanceof GsvClientError) || error.code !== 401) throw error; }
  }
  if (!recovered) {
    space.setupAttempted = true; save();
    const session = client();
    try { await session.requestOnce(socketUrl(space), "sys.setup", { username: space.username, password: space.password, rootPassword: space.rootPassword,
      onboardingToken: space.onboardingToken, agentName: "algo", timezone: "UTC" }); }
    finally { session.disconnect(); }
  }
  const session = await passwordLogin(space); session.disconnect();
  space.setupComplete = true;
  save();
}
async function populate(space: Space): Promise<void> {
  const session = await passwordLogin(space);
  try {
    const written = await session.fs.write({ path: "/home/upgrade/upgrade-proof.txt", content: space.marker });
    check(written.ok, `${space.handle}: write owned sentinel`);
    for (const label of ["web", "cli", "machine"] as const) {
      if (space.credentials[label]) continue;
      if (space.pendingCredential) throw new Error("A previous credential issue has an uncertain outcome; inspect/reconcile it before continuing");
      space.pendingCredential = label; save();
      const result = await session.sys.token.create(label === "machine"
        ? { kind: "machine", label: "legacy-upgrade-machine", peerId: `upgrade-machine-${input.fixtureId}` }
        : { kind: "human", label: `legacy-upgrade-${label}` });
      space.credentials[label] = credentialSchema.parse(result.token);
      delete space.pendingCredential; save();
    }
    const processes = processListSchema.parse(await session.proc.list({}));
    const ship = processes.processes.find((process) => process.personal && process.interactive);
    if (!ship) throw new Error("Legacy personal process was not created");
    space.pid = ship.pid;
    space.conversationId = (await session.conversation.forProcess({ pid: ship.pid })).conversation.id;
    save();
  } finally { session.disconnect(); }
}
async function verify(space: Space): Promise<void> {
  if (!space.installationId || !space.pid || !space.conversationId) throw new Error("Legacy fixture has not been fully populated");
  const detail = await admin(`/admin/api/installations/${space.installationId}`, detailSchema);
  check(detail.installationId === space.installationId && detail.handle === space.handle && detail.state === "active" && detail.canonicalOrigin === origin(space), `${space.handle}: identity and route retained`);
  for (const root of [false, true]) { const session = await passwordLogin(space, root); session.disconnect(); check(true, `${space.handle}: ${root ? "root" : "human"} password retained`); }
  for (const label of ["web", "cli", "machine"]) {
    const credential = space.credentials[label];
    if (!credential) throw new Error("Missing legacy credential");
    const session = client();
    try {
      if (label === "machine") {
        const control = await passwordLogin(space);
        try {
          const { models } = z.object({ models: z.array(z.object({ provider: z.string(), source: z.string() })) }).parse(await control.ai.models({}));
          check(models.length > 0 && models.every((model) => model.provider === "gsv" && model.source === "base"), `${space.handle}: machine availability cannot select an external fallback`);
        } finally { control.disconnect(); }
        session.onRequest(async (request, body) => {
          await body?.stream.cancel("The empty acceptance target does not receive file bodies");
          if (request.call !== "fs.stat") throw new Error("Unsupported acceptance target capability");
          return { data: { ok: false, error: "ENOENT: the acceptance target contains no files" } };
        });
      }
      await session.connect({ url: socketUrl(space), username: space.username, token: credential.token,
        peer: { id: credential.peerId ?? `upgrade-${label}-${input.fixtureId}`, platform: "upgrade-acceptance", version: "1", implements: label === "machine" ? ["fs.stat"] : [] } });
      check(true, `${space.handle}: ${label} protocol credential retained`);
    } finally { session.disconnect(); }
  }
  const session = await passwordLogin(space);
  try {
    const found = await session.fs.search({ path: "/home/upgrade/upgrade-proof.txt", query: space.marker });
    check(found.ok && found.count === 1, `${space.handle}: file content retained`);
    const other = state.spaces.find((candidate) => candidate.handle !== space.handle);
    if (other) { const absent = await session.fs.search({ path: "/home/upgrade/upgrade-proof.txt", query: other.marker }); check(absent.ok && absent.count === 0, `${space.handle}: same path remains isolated`); }
    const processes = processListSchema.parse(await session.proc.list({}));
    check(processes.processes.some((process) => process.pid === space.pid && process.personal), `${space.handle}: Process identity retained`);
    check((await session.conversation.forProcess({ pid: space.pid })).conversation.id === space.conversationId, `${space.handle}: canonical conversation retained`);
  } finally { session.disconnect(); }
}

try {
  if (command === "seed") {
    for (const handle of plan.handles) {
      let space = state.spaces.find((candidate) => candidate.handle === handle);
      if (!space) { space = newSpace(handle); state.spaces.push(space); save(); }
      if (!space.installationId) {
        const issued = await admin("/admin/api/installations", issuedSchema, { operationId: space.operationId, handle });
        check(issued.installation.handle === handle && issued.installation.canonicalOrigin === origin(space), "created only expected fixture route");
        space.installationId = issued.installation.installationId;
        space.onboardingToken = new URL(issued.onboarding.onboardingUrl).hash.slice(1); save();
      }
      await setup(space); await populate(space); await verify(space);
    }
  } else if (command === "reset-legacy") {
    const previous = state.spaces[0];
    if (!previous?.installationId || !previous.setupComplete || state.spaces.length !== 2) throw new Error("Seed both owned spaces first");
    if (!state.reset) { state.reset = { operationId: `upgrade_reset_${randomUUID()}`, previous: structuredClone(previous) }; save(); }
    if (!state.reset.replacementId) {
      const reset = await admin(`/admin/api/installations/${state.reset.previous.installationId}/reset`, issuedSchema, { operationId: state.reset.operationId, confirmHandle: previous.handle });
      check(reset.reset?.previousInstallationId === state.reset.previous.installationId && reset.reset?.dataDeletionState === "pending", "old implementation created genuine pending deletion");
      const replacement = newSpace(previous.handle);
      replacement.installationId = reset.installation.installationId;
      replacement.onboardingToken = new URL(reset.onboarding.onboardingUrl).hash.slice(1);
      state.reset.replacementId = replacement.installationId; state.spaces[0] = replacement; save();
    }
    await setup(state.spaces[0]); await populate(state.spaces[0]);
    for (const space of state.spaces) await verify(space);
  } else {
    if (!state.reset?.replacementId || state.spaces.length !== 2) throw new Error("A genuine legacy pending-deletion fixture is required before verification");
    for (const space of state.spaces) await verify(space);
    const replacement = await admin(`/admin/api/installations/${state.reset.replacementId}`, detailSchema);
    check(replacement.reset?.previousInstallationId === state.reset.previous.installationId && replacement.reset?.dataDeletionState === "pending", "preexisting pending deletion survived handoff without initiating a purge");
    for (const credential of ["password", "web"] as const) {
      const session = client();
      let rejected = false;
      try {
        await session.connect({ url: socketUrl(state.reset.previous), username: state.reset.previous.username,
          ...(credential === "password" ? { password: state.reset.previous.password } : { token: state.reset.previous.credentials.web.token }) });
      } catch (error) {
        if (!(error instanceof GsvClientError) || error.code !== 401) throw error;
        rejected = true;
      } finally { session.disconnect(); }
      check(rejected, `retired installation's old ${credential} cannot authenticate to the replacement`);
    }
  }
  writeFileSync(join(input.artifactsDirectory, `${command}-report.json`), JSON.stringify({ ...report, passed: true, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ command, passed: true, checks: report.checks.length, explicitMessagesSent: 0 }));
} catch (error) {
  writeFileSync(join(input.artifactsDirectory, `${command}-report.json`), JSON.stringify({ ...report, passed: false, failure: error instanceof Error ? error.message : "Unknown failure" }, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ command, passed: false, errorKind: error instanceof Error ? error.name : "Unknown" }));
  process.exitCode = 1;
}
