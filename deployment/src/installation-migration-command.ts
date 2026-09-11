import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as z from "zod/mini";
import { adoptionDigest } from "./installation-migration-adoption-state.ts";
import { cloudflareMigrationD1, type MigrationD1Database } from "./installation-migration-d1.ts";
import { cancelRemoteInstallationMigrationAdoption, executeRemoteInstallationMigrationAdoption, prepareRemoteInstallationMigrationAdoption } from "./installation-migration-adoption-remote.ts";
import { migrationAdoptionContextSchema, readMigrationFreeze } from "./installation-migration-freeze.ts";
import { installationMigrationInventory } from "./installation-migration-inventory.ts";
import { runOwnedInstallationMigrations, type OwnedInstallationMigration } from "./installation-migration-runner.ts";

const sourceDirectory = z.string().check(z.regex(/^[a-z][a-z0-9_/-]*$/));
const requestSchema = z.strictObject({
  context: migrationAdoptionContextSchema,
  legacy: z.strictObject({ repository: z.string(), directory: sourceDirectory }),
  directory: z.strictObject({ repository: z.string(), directory: sourceDirectory }),
  policy: z.strictObject({ repository: z.string(), directory: sourceDirectory }),
  sourceProvenanceFile: z.string(),
  resetProofs: z.array(z.strictObject({ operationId: z.string(), previousInstallationId: z.string(), replacementInstallationId: z.string(),
    kind: z.enum(["legacy-atomic", "service-preparation", "no-services"]), evidenceSha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    participantId: z.string(), preparedAt: z.number().check(z.int(), z.minimum(0)), evidenceFile: z.string() })),
});
type CommandRequest = z.infer<typeof requestSchema>;

function sourceAtRevision(repository: string, revision: string, filename: string): string {
  return execFileSync("git", ["-C", repository, "show", `${revision}:${filename}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1_000_000 });
}

function verifyEvidenceFile(filename: string, checksum: string): void {
  if (adoptionDigest(readFileSync(filename, "utf8")) !== checksum) throw new Error("Reviewed evidence artifact does not match its checksum");
}

/** Artifact hashes bind reviewed bytes; they do not authenticate historical events. */
export function readMigrationCommandRequest(filename: string) {
  const request = requestSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
  const resolve = (value: string): string => path.resolve(path.dirname(filename), value);
  verifyEvidenceFile(resolve(request.sourceProvenanceFile), request.context.legacySourceEvidenceSha256);
  const resetProofs = request.resetProofs.map(({ evidenceFile, ...proof }) => {
    verifyEvidenceFile(resolve(evidenceFile), proof.evidenceSha256);
    return proof;
  });
  const sources = installationMigrationInventory.map(({ name }) => ({ name,
    sql: sourceAtRevision(resolve(request.legacy.repository), request.context.legacyRunnerRevision, `${request.legacy.directory}/${name}`) }));
  return { request, sources, resetProofs, resolve };
}

function ownedSources(request: CommandRequest, resolve: (value: string) => string): OwnedInstallationMigration[] {
  return (["directory", "policy"] as const).flatMap((owner) => {
    const source = request[owner];
    const revision = owner === "directory" ? request.context.directoryRunnerRevision : request.context.policyRunnerRevision;
    const names = execFileSync("git", ["-C", resolve(source.repository), "ls-tree", "--name-only", revision, `${source.directory}/`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").filter(Boolean);
    return names.map((filename) => {
      const name = path.posix.basename(filename);
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || path.posix.dirname(filename) !== source.directory) {
        throw new Error("Owner migration directory contains an unexpected entry");
      }
      return { owner, name, sql: sourceAtRevision(resolve(source.repository), revision, filename) };
    });
  });
}

export async function runInstallationMigrationCommand(input: {
  action: "prepare" | "apply" | "cancel" | "status" | "forward";
  requestFile: string;
  database: MigrationD1Database;
  outputDirectory?: string;
  approvedPreconditionSha256?: string;
}) {
  const loaded = readMigrationCommandRequest(input.requestFile);
  const adoption = { database: input.database, context: loaded.request.context, sources: loaded.sources, resetProofs: loaded.resetProofs };
  if (input.action === "status") {
    const record = await readMigrationFreeze(input.database);
    if (record && (record.context.operationId !== adoption.context.operationId
      || record.context.accountId !== input.database.identity.accountId || record.context.databaseId !== input.database.identity.databaseId)) {
      throw new Error("Remote migration status belongs to another operation");
    }
    return { operationId: adoption.context.operationId, phase: record?.phase ?? "not-started",
      preconditionSha256: record?.preconditionSha256 ?? null, postconditionSha256: record?.postconditionSha256 ?? null };
  }
  if (input.action === "prepare") {
    if (!input.outputDirectory) throw new Error("A new private artifact directory is required before freezing D1");
    mkdirSync(input.outputDirectory, { mode: 0o700 });
    const prepared = await prepareRemoteInstallationMigrationAdoption(adoption);
    try {
      const snapshotFile = path.join(input.outputDirectory, "snapshot.sqlite");
      await backup(prepared.snapshot, snapshotFile);
      chmodSync(snapshotFile, 0o600);
      const planFile = path.join(input.outputDirectory, "plan.json");
      writeFileSync(planFile, JSON.stringify({ context: adoption.context, plan: prepared.plan,
        snapshotSha256: createHash("sha256").update(readFileSync(snapshotFile)).digest("hex") }, null, 2), { flag: "wx", mode: 0o600 });
      return { operationId: adoption.context.operationId, phase: "frozen", preconditionSha256: prepared.plan.preconditionSha256 };
    } finally { prepared.snapshot.close(); }
  }
  if (input.action === "apply") {
    if (!input.approvedPreconditionSha256 || !/^[a-f0-9]{64}$/.test(input.approvedPreconditionSha256)) {
      throw new Error("Apply requires the exact reviewed frozen precondition checksum");
    }
    return executeRemoteInstallationMigrationAdoption({ ...adoption, approvedPreconditionSha256: input.approvedPreconditionSha256 });
  }
  if (input.action === "cancel") {
    await cancelRemoteInstallationMigrationAdoption(adoption);
    return { operationId: adoption.context.operationId, phase: "cancelled" };
  }
  return runOwnedInstallationMigrations({ database: input.database, operationId: adoption.context.operationId,
    sources: ownedSources(loaded.request, loaded.resolve) });
}

export async function installationMigrationMain(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    request: { type: "string" }, output: { type: "string" }, "approved-precondition": { type: "string" },
  } });
  const action = z.enum(["prepare", "apply", "cancel", "status", "forward"]).parse(positionals[0]);
  if (!values.request || positionals.length !== 1) throw new Error("Use <prepare|apply|cancel|status|forward> --request <file>");
  const { request } = readMigrationCommandRequest(values.request);
  const database = cloudflareMigrationD1({ accountId: request.context.accountId, databaseId: request.context.databaseId,
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" });
  const result = await runInstallationMigrationCommand({ action, requestFile: values.request, database,
    outputDirectory: values.output, approvedPreconditionSha256: values["approved-precondition"] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installationMigrationMain();
}
