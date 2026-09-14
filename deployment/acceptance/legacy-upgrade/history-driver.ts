import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createFixtureClient } from "./fixture-client.ts";
import { LEGACY_PUBLIC_REVISION, upgradeFixturePlan, upgradeFixtureSchema } from "./plan.ts";
import { readPrivateState, writePrivateState } from "./private-state.ts";
import { assertUpgradeBuildReceipt } from "./receipt.ts";
import { captureLegacyUpgradeHistory, legacyHistoryProofSchema, seedLegacyUpgradeHistory, verifyLegacyUpgradeHistory } from "./history-proof.ts";

process.umask(0o077);
const [file, phase, authorization] = process.argv.slice(2);
if (!file || (phase !== "seed-legacy" && phase !== "capture-legacy" && phase !== "verify-current") || authorization !== "--owned-fixtures-only") {
  throw new Error("Usage: node history-driver.ts /secure/fixture.json seed-legacy|capture-legacy|verify-current --owned-fixtures-only");
}
const input = upgradeFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const plan = upgradeFixturePlan(input);
assertUpgradeBuildReceipt(input, phase === "verify-current" ? "current" : "legacy");
const saved = z.object({ fixtureId: z.literal(input.fixtureId), spaces: z.array(z.object({
  handle: z.string(), installationId: z.string(), pid: z.string(), conversationId: z.string(), username: z.literal("upgrade"),
  credentials: z.object({ web: z.object({ kind: z.literal("human"), token: z.string() }) }),
})) }).parse(JSON.parse(readPrivateState(join(input.artifactsDirectory, "credentials.json"))));
const spaces = saved.spaces.filter((space) => space.handle === plan.handles[1]);
if (spaces.length !== 1) throw new Error("History acceptance requires exactly the controlled B fixture");
const space = spaces[0];
const intentFile = join(input.artifactsDirectory, "history-intent.json");
const proofFile = join(input.artifactsDirectory, "history-proof.json");
const intentSchema = z.object({ fixtureId: z.literal(input.fixtureId), installationId: z.literal(space.installationId),
  pid: z.literal(space.pid), conversationId: z.literal(space.conversationId), idempotencyKey: z.string().min(1), sentinel: z.string().min(1) });
if (!existsSync(intentFile)) {
  if (phase !== "seed-legacy") throw new Error("The historical message intent was not saved");
  writePrivateState(intentFile, JSON.stringify({ fixtureId: input.fixtureId, installationId: space.installationId,
    pid: space.pid, conversationId: space.conversationId, idempotencyKey: `upgrade_history_${randomUUID()}`,
    sentinel: `Upgrade acceptance history sentinel ${randomBytes(16).toString("hex")}` }, null, 2));
}
const savedIntent = intentSchema.parse(JSON.parse(readPrivateState(intentFile)));
const intent = { pid: savedIntent.pid, conversationId: savedIntent.conversationId,
  idempotencyKey: savedIntent.idempotencyKey, sentinel: savedIntent.sentinel };
const client = createFixtureClient();
const reportFile = join(input.artifactsDirectory, `history-${phase}-report.json`);
try {
  if (phase !== "verify-current") {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (process.env.CLOUDFLARE_ACCOUNT_ID !== input.accountId || !token) throw new Error("History seed requires explicit Cloudflare account and authentication");
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${plan.names.inference}/settings`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Inference binding verification failed with HTTP ${response.status}`); }
    const settings = z.object({ success: z.literal(true), result: z.object({ bindings: z.array(z.object({
      name: z.string(), type: z.string(), json: z.unknown().optional(), service: z.string().optional(),
    })) }) }).parse(await response.json());
    const enabled = settings.result.bindings.filter((binding) => binding.name === "MANAGED_INFERENCE_ENABLED");
    const accounts = settings.result.bindings.filter((binding) => binding.name === "ACCOUNTS");
    if (enabled.length !== 1 || enabled[0].type !== "json" || accounts.length !== 1 || accounts[0].service !== plan.names.accounts) {
      throw new Error("Inference settings do not belong to the reviewed disabled fixture");
    }
    const disabled = z.union([z.literal(false), z.literal("false")]).safeParse(enabled[0].json);
    if (!disabled.success) throw new Error("History seed requires the deployed inference JSON binding to be boolean false");
    writePrivateState(join(input.artifactsDirectory, "history-inference-guard.json"), JSON.stringify({
      accountId: input.accountId, worker: plan.names.inference, accountsService: plan.names.accounts,
      managedInferenceEnabled: false, observedAt: new Date().toISOString(),
    }, null, 2));
  }
  const connected = await client.connect({ url: `wss://${space.handle}.${input.domain}/ws`, username: space.username,
    token: space.credentials.web.token, peer: { id: `upgrade-history-${input.fixtureId}`, platform: "upgrade-acceptance", version: "1", implements: [] } });
  if (connected.server.release !== (phase === "verify-current" ? input.currentPublicRevision : LEGACY_PUBLIC_REVISION)) {
    throw new Error("History acceptance connected to an unexpected gateway release");
  }
  if (phase !== "verify-current" && !existsSync(proofFile)) {
    const proof = phase === "seed-legacy"
      ? await seedLegacyUpgradeHistory({ client, intent, managedInferenceEnabled: false, phase })
      : await captureLegacyUpgradeHistory({ client, intent, managedInferenceEnabled: false, phase });
    writePrivateState(proofFile, JSON.stringify(proof, null, 2));
  } else {
    const proof = legacyHistoryProofSchema.parse(JSON.parse(readPrivateState(proofFile)));
    await verifyLegacyUpgradeHistory({ client, intent, proof });
  }
  const report = { passed: true, phase, fixtureId: input.fixtureId, installationId: space.installationId,
    proofFile, externalInference: { expectedRequests: 0,
      basis: "verified disabled binding and base-only GSV stack", telemetryMeasured: false },
    observedAt: new Date().toISOString() };
  writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} catch (error) {
  writeFileSync(reportFile, JSON.stringify({ passed: false, phase, error: error instanceof Error ? error.message : "Unknown failure" }, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ passed: false, phase, errorKind: error instanceof Error ? error.name : "Unknown" }));
  process.exitCode = 1;
} finally { client.disconnect(); }
