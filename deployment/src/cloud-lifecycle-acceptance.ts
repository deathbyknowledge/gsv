import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { installationDeletionReceiptSchema } from "@humansandmachines/gsv/services/lifecycle";

const id = z.string().min(1).max(128);
const origin = z.string().refine((value) => { try { return new URL(value).protocol === "https:" && new URL(value).origin === value; } catch { return false; } });
const fixtureSchema = z.strictObject({ installationId: id, handle: id, canonicalOrigin: origin });
export const lifecycleRowSchema = z.strictObject({ id, handle: id, state: id });
export const lifecycleConfigurationSchema = z.strictObject({
  version: z.literal(1), runId: z.string().regex(/^[a-z0-9-]{8,64}$/),
  accountId: id, databaseId: id, accountsWorker: id, accountsOrigin: origin,
  fixtures: z.strictObject({ a: fixtureSchema, b: fixtureSchema }),
  expectedSpaces: z.array(lifecycleRowSchema).min(2),
});
export const lifecycleCredentialsSchema = z.strictObject({ username: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), password: z.string().min(12), rootPassword: z.string().min(12) });
export const lifecycleInstallationSchema = z.object({ installationId: id, handle: id, canonicalOrigin: origin, state: id,
  reset: z.object({ previousInstallationId: id, dataDeletionState: id }).nullable() });
const onboardingSchema = z.object({ installationId: id, onboardingUrl: z.string().url(), expiresAt: z.number() });
export const lifecycleIssuedSchema = z.object({ installation: lifecycleInstallationSchema, onboarding: onboardingSchema });
export const lifecycleDeletionSchema = z.object({ operationId: id, installationId: id, phase: z.enum(["quiescing", "erasing", "live-erased", "erased"]),
  owners: z.array(z.object({ id, outcome: id, receipt: installationDeletionReceiptSchema.nullable() })) });
const phaseSchema = z.enum(["prepared", "seeding", "seeded", "resetting", "reset", "setting-up", "setup", "verified"]);
export const lifecycleStateSchema = z.strictObject({
  version: z.literal(1), configuration: lifecycleConfigurationSchema, approvalSha256: z.string(),
  baseline: z.array(lifecycleRowSchema), bHistorySha256: z.string(),
  credentials: z.strictObject({ a: lifecycleCredentialsSchema, b: lifecycleCredentialsSchema, replacement: lifecycleCredentialsSchema }),
  path: z.string(), markers: z.strictObject({ a: z.string(), b: z.string(), replacement: z.string() }),
  resetOperationId: id, deletionOperationId: id, phase: phaseSchema,
  replacementId: id.nullable(), onboarding: onboardingSchema.nullable(),
  replacementWasEmpty: z.boolean(), retired: z.boolean(), inventorySha256: z.string().nullable(),
  deletion: lifecycleDeletionSchema.nullable(), checkpoints: z.array(z.object({ action: z.string(), at: z.string() })),
});
export type LifecycleConfiguration = z.infer<typeof lifecycleConfigurationSchema>;
export type LifecycleCredentials = z.infer<typeof lifecycleCredentialsSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
type Installation = z.infer<typeof lifecycleInstallationSchema>;
type Issued = z.infer<typeof lifecycleIssuedSchema>;
type Deletion = z.infer<typeof lifecycleDeletionSchema>;
export type LifecycleAction = "seed" | "reset" | "setup" | "verify" | "retire" | "delete" | "deletion-status" | "deletion-retry";
export type LifecycleGateway = { origin: string; credentials: LifecycleCredentials };
export type LifecycleDependencies = {
  snapshot(): Promise<z.infer<typeof lifecycleRowSchema>[]>;
  installation(installationId: string): Promise<Installation>;
  history(gateway: LifecycleGateway): Promise<string>;
  read(gateway: LifecycleGateway, path: string): Promise<string | null>;
  write(gateway: LifecycleGateway, path: string, content: string): Promise<void>;
  login(gateway: LifecycleGateway, root: boolean): Promise<boolean>;
  reset(installationId: string, operationId: string, confirmHandle: string): Promise<Issued>;
  setup(gateway: LifecycleGateway, token: string): Promise<void>;
  retire(installationId: string, operationId: string, confirmHandle: string): Promise<void>;
  deletion(action: "delete" | "deletion-status" | "deletion-retry", installationId: string, operationId: string, inventorySha256: string): Promise<Deletion>;
  save(state: LifecycleState): Promise<void>;
};
export type LifecycleJson = z.infer<ReturnType<typeof z.json>>;
export function lifecycleDigest(value: LifecycleJson): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sorted(rows: LifecycleState["baseline"]): LifecycleState["baseline"] { return [...rows].sort((a, b) => a.id.localeCompare(b.id)); }
function requireCondition(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
function approval(state: LifecycleState): string {
  return lifecycleDigest({ configuration: state.configuration, baseline: state.baseline, bHistorySha256: state.bHistorySha256,
    credentialsSha256: lifecycleDigest(state.credentials), path: state.path, markers: state.markers,
    resetOperationId: state.resetOperationId, deletionOperationId: state.deletionOperationId });
}
function gateway(state: LifecycleState, fixture: "a" | "b" | "replacement"): LifecycleGateway {
  return { origin: state.configuration.fixtures[fixture === "replacement" ? "a" : fixture].canonicalOrigin, credentials: state.credentials[fixture] };
}
async function checkpoint(state: LifecycleState, deps: LifecycleDependencies, action: string): Promise<void> {
  state.checkpoints.push({ action, at: new Date().toISOString() });
  // The concrete store fsyncs the private file and directory before the caller may send a mutation.
  await deps.save(state);
}

/** Prepare reads only. Its digest binds the complete reviewed baseline and both immutable fixture identities. */
export async function prepareCloudLifecycle(configuration: LifecycleConfiguration, credentials: { a: LifecycleCredentials; b: LifecycleCredentials }, deps: LifecycleDependencies): Promise<LifecycleState> {
  const config = lifecycleConfigurationSchema.parse(configuration);
  const original = { a: lifecycleCredentialsSchema.parse(credentials.a), b: lifecycleCredentialsSchema.parse(credentials.b) };
  requireCondition(config.fixtures.a.installationId !== config.fixtures.b.installationId && config.fixtures.a.handle !== config.fixtures.b.handle
    && config.fixtures.a.canonicalOrigin !== config.fixtures.b.canonicalOrigin, "Fixtures must have distinct identities and origins");
  requireCondition(new Set(config.expectedSpaces.map((row) => row.id)).size === config.expectedSpaces.length, "Expected registry must contain distinct spaces");
  requireCondition(original.a.username === original.b.username, "Fixtures must use the same local username");
  const baseline = sorted(await deps.snapshot());
  requireCondition(JSON.stringify(baseline) === JSON.stringify(sorted(config.expectedSpaces)), "Cloud account registry differs from the reviewed scope");
  for (const key of ["a", "b"] as const) {
    const fixture = config.fixtures[key];
    const current = await deps.installation(fixture.installationId);
    requireCondition(current.installationId === fixture.installationId && current.handle === fixture.handle && current.canonicalOrigin === fixture.canonicalOrigin
      && current.state === "active" && baseline.some((row) => row.id === fixture.installationId && row.handle === fixture.handle && row.state === "active"), "Fixture identity is not the reviewed active space");
    const connection = { origin: fixture.canonicalOrigin, credentials: original[key] };
    requireCondition(await deps.login(connection, false) && await deps.login(connection, true), "Fixture credentials must work before reset");
  }
  const path = `/home/${original.a.username}/.gsv-acceptance-${config.runId}.txt`;
  for (const key of ["a", "b"] as const) requireCondition(await deps.read({ origin: config.fixtures[key].canonicalOrigin, credentials: original[key] }, path) === null, "Acceptance path already exists; choose a new run ID");
  const state: LifecycleState = { version: 1, configuration: config, approvalSha256: "", baseline,
    bHistorySha256: await deps.history({ origin: config.fixtures.b.canonicalOrigin, credentials: original.b }),
    credentials: { ...original, replacement: { username: original.a.username, password: Buffer.from(randomBytes(32)).toString("base64url"), rootPassword: Buffer.from(randomBytes(32)).toString("base64url") } },
    path, markers: { a: `acceptance:${config.runId}:a:${randomUUID()}`, b: `acceptance:${config.runId}:b:${randomUUID()}`, replacement: `acceptance:${config.runId}:replacement:${randomUUID()}` },
    resetOperationId: randomUUID(), deletionOperationId: randomUUID(), phase: "prepared", replacementId: null, onboarding: null,
    replacementWasEmpty: false, retired: false, inventorySha256: null, deletion: null, checkpoints: [],
  };
  state.approvalSha256 = approval(state);
  await checkpoint(state, deps, "prepared");
  return state;
}

function accountsDeletionProof(state: LifecycleState, progress: Deletion) {
  const oldId = state.configuration.fixtures.a.installationId;
  requireCondition(progress.installationId === oldId && progress.operationId === state.deletionOperationId, "Deletion status belongs to another operation");
  // The coordinator removes owner receipts once its final tombstone records complete erasure.
  if (progress.phase === "erased") return { erased: true, erasing: true };
  const receipt = progress.owners.find((owner) => owner.id === "accounts")?.receipt;
  const matching = receipt?.installationId === oldId && receipt.operationId === state.deletionOperationId;
  return {
    erased: Boolean(matching && ["live-erased", "erased"].includes(receipt.phase) && receipt.pendingResources === 0),
    erasing: Boolean(matching && ["erasing", "live-erased", "erased"].includes(receipt.phase)),
  };
}

/** Fail closed on a new space, changed bystander, or a replacement without the trusted reset relationship. */
async function preserveRegistry(state: LifecycleState, deps: LifecycleDependencies): Promise<Installation | null> {
  const rows = await deps.snapshot();
  const oldId = state.configuration.fixtures.a.installationId;
  const original = rows.find((row) => row.id === oldId);
  let accountsErased = false;
  let accountsErasing = false;
  if (state.retired && state.inventorySha256 && (!original || state.deletion)) {
    // Query current server progress: the erase reply may have been lost before the local checkpoint.
    const progress = lifecycleDeletionSchema.parse(await deps.deletion("deletion-status", oldId, state.deletionOperationId, state.inventorySha256));
    ({ erased: accountsErased, erasing: accountsErasing } = accountsDeletionProof(state, progress));
    state.deletion = progress;
  }
  requireCondition(Boolean(original) || accountsErased, "Original immutable identity disappeared without Accounts erasure proof");
  for (const baseline of state.baseline.filter((row) => row.id !== oldId)) {
    requireCondition(JSON.stringify(rows.find((row) => row.id === baseline.id)) === JSON.stringify(baseline), "A protected space changed; stop acceptance");
  }
  const extra = rows.filter((row) => !state.baseline.some((before) => before.id === row.id));
  if (extra.length === 0) {
    requireCondition(!state.replacementId && ["prepared", "seeding", "seeded", "resetting"].includes(state.phase)
      && JSON.stringify(original) === JSON.stringify(state.baseline.find((row) => row.id === oldId)), "Original space changed without a recorded replacement");
    return null;
  }
  requireCondition(extra.length === 1 && !["prepared", "seeding", "seeded"].includes(state.phase), "Unexpected installation allocation");
  const replacement = await deps.installation(extra[0].id);
  if (!replacement.reset && !accountsErased && state.retired && state.inventorySha256) {
    const progress = lifecycleDeletionSchema.parse(await deps.deletion("deletion-status", oldId, state.deletionOperationId, state.inventorySha256));
    ({ erased: accountsErased, erasing: accountsErasing } = accountsDeletionProof(state, progress));
    if (accountsErasing) state.deletion = progress;
  }
  const target = state.configuration.fixtures.a;
  requireCondition(replacement.installationId === extra[0].id && replacement.installationId !== oldId
    && (!state.replacementId || state.replacementId === replacement.installationId)
    && replacement.handle === target.handle && replacement.canonicalOrigin === target.canonicalOrigin
    && (replacement.reset?.previousInstallationId === oldId || (accountsErasing && state.replacementId === replacement.installationId)), "Replacement does not belong to this reset");
  requireCondition(!original || ["retained", "deleting", "deleted"].includes(original.state), "Old identity is still admitting work");
  return replacement;
}
async function preserveB(state: LifecycleState, deps: LifecycleDependencies, marker = true): Promise<void> {
  const b = gateway(state, "b");
  requireCondition(await deps.login(b, false) && await deps.login(b, true), "Protected fixture credentials changed");
  requireCondition(await deps.history(b) === state.bHistorySha256, "Protected fixture conversation changed");
  if (marker) requireCondition(await deps.read(b, state.path) === state.markers.b, "Protected fixture data changed");
}
async function marker(state: LifecycleState, deps: LifecycleDependencies, key: "a" | "b" | "replacement"): Promise<void> {
  const connection = gateway(state, key);
  const current = await deps.read(connection, state.path);
  requireCondition(current === null || current === state.markers[key], "Acceptance path contains unexpected data; refusing overwrite");
  if (current === null) await deps.write(connection, state.path, state.markers[key]);
  requireCondition(await deps.read(connection, state.path) === state.markers[key], "Acceptance write did not persist");
}
function issued(state: LifecycleState, response: Issued): void {
  const a = state.configuration.fixtures.a;
  const parsed = lifecycleIssuedSchema.parse(response);
  const url = new URL(parsed.onboarding.onboardingUrl);
  requireCondition(parsed.installation.installationId !== a.installationId && parsed.installation.reset?.previousInstallationId === a.installationId
    && parsed.installation.handle === a.handle && parsed.installation.canonicalOrigin === a.canonicalOrigin
    && (!state.replacementId || state.replacementId === parsed.installation.installationId)
    && parsed.onboarding.installationId === parsed.installation.installationId && url.origin === a.canonicalOrigin
    && url.pathname === "/onboarding" && url.hash.length > 1, "Reset response has the wrong scope");
  state.replacementId = parsed.installation.installationId;
  state.onboarding = parsed.onboarding;
}

export async function runCloudLifecycle(state: LifecycleState, action: LifecycleAction, approvedSha256: string, deps: LifecycleDependencies, inventorySha256?: string): Promise<LifecycleState> {
  requireCondition(approvedSha256 === state.approvalSha256 && approval(state) === approvedSha256, "Exact prepared approval digest is required");
  const replacement = await preserveRegistry(state, deps);
  if (action === "seed") {
    requireCondition(["prepared", "seeding", "seeded"].includes(state.phase), "Seed is only available before reset");
    await preserveB(state, deps, state.phase === "seeded");
    state.phase = "seeding";
    await checkpoint(state, deps, "seed-intent");
    await marker(state, deps, "a");
    await marker(state, deps, "b");
    state.phase = "seeded";
  } else if (action === "reset") {
    requireCondition(["seeded", "resetting", "reset"].includes(state.phase), "Reset requires seeded fixtures and cannot replay after setup");
    await preserveB(state, deps);
    if (!replacement) requireCondition(await deps.read(gateway(state, "a"), state.path) === state.markers.a, "Original fixture data changed before reset");
    state.phase = "resetting";
    await checkpoint(state, deps, "reset-intent");
    // An active replacement after an uncertain reply is reconciled using the credentials saved in prepare.
    if (replacement?.state === "active") {
      requireCondition(await deps.login(gateway(state, "replacement"), false) && await deps.login(gateway(state, "replacement"), true), "Active replacement credentials do not match this run");
      state.replacementId = replacement.installationId;
      state.phase = "setting-up";
    } else {
      issued(state, await deps.reset(state.configuration.fixtures.a.installationId, state.resetOperationId, state.configuration.fixtures.a.handle));
      state.phase = "reset";
    }
  } else if (action === "setup") {
    requireCondition(["reset", "setting-up", "setup"].includes(state.phase) && Boolean(replacement) && Boolean(state.replacementId), "Setup requires this run's recorded replacement");
    await preserveB(state, deps);
    state.phase = "setting-up";
    await checkpoint(state, deps, "setup-intent");
    if (replacement!.state !== "active") {
      if (!state.onboarding || state.onboarding.expiresAt <= Date.now()) {
        issued(state, await deps.reset(state.configuration.fixtures.a.installationId, state.resetOperationId, state.configuration.fixtures.a.handle));
        await checkpoint(state, deps, "onboarding-refreshed");
      }
      await deps.setup(gateway(state, "replacement"), new URL(state.onboarding!.onboardingUrl).hash.slice(1));
    }
    requireCondition(await deps.login(gateway(state, "replacement"), false) && await deps.login(gateway(state, "replacement"), true), "Replacement credentials do not work");
    if (!state.replacementWasEmpty) {
      requireCondition(await deps.read(gateway(state, "replacement"), state.path) === null, "Replacement inherited old fixture data");
      state.replacementWasEmpty = true;
      await checkpoint(state, deps, "replacement-empty");
    }
    await marker(state, deps, "replacement");
    state.phase = "setup";
  } else if (action === "verify") {
    requireCondition(["setup", "verified"].includes(state.phase) && replacement?.state === "active" && state.replacementWasEmpty, "Replacement setup has not been verified");
    requireCondition(!await deps.login(gateway(state, "a"), false) && !await deps.login(gateway(state, "a"), true), "Old credentials still authenticate to the replacement");
    requireCondition(await deps.login(gateway(state, "replacement"), false) && await deps.login(gateway(state, "replacement"), true), "Replacement credentials stopped working");
    requireCondition(await deps.read(gateway(state, "replacement"), state.path) === state.markers.replacement, "Replacement data changed");
    state.phase = "verified";
  } else {
    requireCondition(state.phase === "verified" && replacement?.state === "active", "Deletion requires verified replacement isolation");
    await preserveB(state, deps);
    requireCondition(await deps.login(gateway(state, "replacement"), false) && await deps.login(gateway(state, "replacement"), true)
      && await deps.read(gateway(state, "replacement"), state.path) === state.markers.replacement, "Replacement data or credentials changed before deletion");
    const oldId = state.configuration.fixtures.a.installationId;
    if (action === "retire") {
      const old = await deps.installation(oldId);
      requireCondition(old.installationId === oldId && old.state === "retained" && old.handle !== state.configuration.fixtures.a.handle, "Only the retired original may enter deletion");
      await checkpoint(state, deps, "retire-intent");
      await deps.retire(oldId, state.deletionOperationId, old.handle);
      state.retired = true;
    } else {
      requireCondition(state.retired, "Pin retirement operation before inventory registration");
      if (action === "delete") {
        requireCondition(Boolean(inventorySha256?.match(/^[a-f0-9]{64}$/)) && (!state.inventorySha256 || state.inventorySha256 === inventorySha256), "Explicit immutable inventory digest is required");
        state.inventorySha256 = inventorySha256!;
      }
      requireCondition(Boolean(state.inventorySha256), "Deletion has not begun with an approved inventory");
      await checkpoint(state, deps, `${action}-intent`);
      const progress = lifecycleDeletionSchema.parse(await deps.deletion(action, oldId, state.deletionOperationId, state.inventorySha256!));
      requireCondition(progress.installationId === oldId && progress.operationId === state.deletionOperationId, "Deletion response belongs to another operation");
      state.deletion = progress;
    }
  }
  await preserveRegistry(state, deps);
  await preserveB(state, deps);
  if (state.phase === "verified") requireCondition(await deps.login(gateway(state, "replacement"), false) && await deps.login(gateway(state, "replacement"), true)
    && await deps.read(gateway(state, "replacement"), state.path) === state.markers.replacement, "Replacement data or credentials changed");
  await checkpoint(state, deps, `${action}-complete`);
  return state;
}
export function cloudLifecycleReport(state: LifecycleState) {
  return { version: 1, accountId: state.configuration.accountId, phase: state.phase, approvalSha256: state.approvalSha256,
    originalId: state.configuration.fixtures.a.installationId, protectedFixtureId: state.configuration.fixtures.b.installationId,
    replacementId: state.replacementId, protectedSpaces: state.baseline.length - 1, replacementWasEmpty: state.replacementWasEmpty,
    retired: state.retired, deletionOperationId: state.deletionOperationId, deletionPhase: state.deletion?.phase ?? "not-started",
    deletionComplete: state.deletion?.phase === "erased", owners: state.deletion?.owners.map(({ id, outcome }) => ({ id, outcome })) ?? [],
    checkpointCount: state.checkpoints.length };
}
