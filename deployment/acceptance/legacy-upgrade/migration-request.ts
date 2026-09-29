import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { adoptionDigest } from "../../src/installation-migration-adoption-state.ts";
import { cloudflareMigrationD1, migrationD1Read } from "../../src/installation-migration-d1.ts";
import { LEGACY_PRIVATE_REVISION, LEGACY_PUBLIC_REVISION, upgradeFixturePlan, upgradeFixtureSchema } from "./plan.ts";
import { assertUpgradeBuildReceipt } from "./receipt.ts";
import { readPrivateState } from "./private-state.ts";

process.umask(0o077);
const [file, deploymentFile] = process.argv.slice(2);
if (!file || !deploymentFile) throw new Error("Usage: node migration-request.ts /secure/fixture.json /secure/reviewed-handoff.json");
const input = upgradeFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const plan = upgradeFixturePlan(input);
assertUpgradeBuildReceipt(input, "legacy");
assertUpgradeBuildReceipt(input, "current");
if (process.env.CLOUDFLARE_ACCOUNT_ID !== input.accountId) throw new Error("Explicit reviewed Cloudflare account is required");

// This operator-reviewed receipt binds historical deployment observations. A local
// artifact hash alone cannot authenticate which source actually ran in the cloud.
const sourceEvidence = readFileSync(deploymentFile, "utf8");
const deployed = z.object({ phase: z.literal("handoff"), prefix: z.literal(plan.prefix), accountId: z.literal(input.accountId),
  databaseId: z.string().regex(/^[a-f0-9-]{36}$/), publicRevision: z.literal(LEGACY_PUBLIC_REVISION),
  privateRevision: z.literal(LEGACY_PRIVATE_REVISION), legacyRunnerDisabled: z.literal(true),
  legacyBuildReceiptSha256: z.literal(adoptionDigest(readFileSync(join(input.artifactsDirectory, "legacy/receipt.json"), "utf8"))),
  observedAt: z.iso.datetime(), workers: z.array(z.object({ name: z.string(), versionId: z.string().min(1) })).length(4),
}).parse(JSON.parse(sourceEvidence));
const expectedWorkers = [plan.names.accounts, plan.names.gateway, plan.names.inference, plan.names.ripgit].sort();
if (deployed.workers.map((worker) => worker.name).sort().join("\n") !== expectedWorkers.join("\n")) throw new Error("Handoff receipt has unexpected Worker identities");
const state = z.object({ fixtureId: z.literal(input.fixtureId), reset: z.object({ operationId: z.string(),
  previous: z.object({ installationId: z.string(), handle: z.literal(plan.handles[0]) }), replacementId: z.string() }),
  spaces: z.array(z.object({ handle: z.string(), installationId: z.string() })).length(2),
}).parse(JSON.parse(readPrivateState(join(input.artifactsDirectory, "credentials.json"))));
if (state.spaces.map((space) => space.handle).sort().join("\n") !== [...plan.handles].sort().join("\n")
  || state.spaces[0].installationId !== state.reset.replacementId) throw new Error("Reset evidence belongs to another fixture");

const database = cloudflareMigrationD1({ accountId: input.accountId, databaseId: deployed.databaseId,
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" });
const rows = await migrationD1Read(database, `SELECT r.operation_id, r.previous_installation_id, r.replacement_installation_id,
  r.handle, r.data_deletion_state, p.participant_id, p.state, i.prepared_at
  FROM installation_reset_operations r
  JOIN installation_reset_participants p ON p.operation_id = r.operation_id
  JOIN managed_inference_reset_receipts i ON i.operation_id = r.operation_id
    AND i.previous_installation_id = r.previous_installation_id AND i.replacement_installation_id = r.replacement_installation_id
  WHERE r.operation_id = ?`, [state.reset.operationId]);
if (rows.length !== 1) throw new Error("Expected one genuine historical reset preparation receipt");
const receipt = z.object({ operation_id: z.literal(state.reset.operationId), previous_installation_id: z.literal(state.reset.previous.installationId),
  replacement_installation_id: z.literal(state.reset.replacementId), handle: z.literal(plan.handles[0]), data_deletion_state: z.literal("pending"),
  participant_id: z.literal("inference"), state: z.literal("prepared"), prepared_at: z.number().int().nonnegative(),
}).parse(rows[0]);
const resetEvidenceFile = join(input.artifactsDirectory, "historical-reset-proof.json");
const resetEvidence = JSON.stringify({ accountId: input.accountId, databaseId: deployed.databaseId, observedAt: new Date().toISOString(), receipt }, null, 2);
writeFileSync(resetEvidenceFile, resetEvidence, { mode: 0o600, flag: "wx" });
const request = {
  context: { operationId: `upgrade_adoption_${input.fixtureId}`, environment: plan.stage, accountId: input.accountId, databaseId: deployed.databaseId,
    legacyRunnerRevision: LEGACY_PRIVATE_REVISION, directoryRunnerRevision: input.currentPublicRevision, policyRunnerRevision: input.currentPrivateRevision,
    legacySourceEvidenceSha256: adoptionDigest(sourceEvidence), legacyRunnerFrozen: true, legacyLedger: "d1_migrations",
    directoryLedger: "installation_migrations", policyLedger: "inference_migrations" },
  legacy: { repository: input.privateRepository, directory: "accounts/migrations" },
  directory: { repository: input.publicRepository, directory: "workers/installations/migrations" },
  policy: { repository: input.privateRepository, directory: "inference/migrations" },
  sourceProvenanceFile: resolve(deploymentFile),
  resetProofs: [{ operationId: receipt.operation_id, previousInstallationId: receipt.previous_installation_id,
    replacementInstallationId: receipt.replacement_installation_id, kind: "service-preparation", evidenceSha256: adoptionDigest(resetEvidence),
    participantId: "inference", preparedAt: receipt.prepared_at, evidenceFile: resetEvidenceFile }],
};
const requestFile = join(input.artifactsDirectory, "migration-request.json");
writeFileSync(requestFile, JSON.stringify(request, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ requestFile, resetPreparationVerified: true, remoteWrites: 0 }));
