import { z } from "zod";

export const LEGACY_PUBLIC_REVISION = "6915d5e65f6891b248d9081c6cf0901e0a57b939";
export const LEGACY_PRIVATE_REVISION = "3777be4bd18e5d6a201aa4c81683b309442ca675";

export const upgradeFixtureSchema = z.strictObject({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  domain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
  fixtureId: z.string().regex(/^[a-f0-9]{8}$/),
  profile: z.string().min(1),
  publicRepository: z.string().startsWith("/"),
  privateRepository: z.string().startsWith("/"),
  currentPublicRevision: z.string().regex(/^[a-f0-9]{40}$/),
  currentPrivateRevision: z.string().regex(/^[a-f0-9]{40}$/),
  artifactsDirectory: z.string().startsWith("/"),
});
export type UpgradeFixture = z.infer<typeof upgradeFixtureSchema>;
export type UpgradePhase = "legacy" | "handoff" | "current";

/** Exact leaf routes let this fixture coexist with another stack's wildcard. */
export function upgradeFixturePlan(input: UpgradeFixture) {
  const prefix = `gsv-upgrade-${input.fixtureId}`;
  const handles = [`upg-${input.fixtureId}-a`, `upg-${input.fixtureId}-b`];
  const adminHost = `upg-${input.fixtureId}-admin.${input.domain}`;
  return {
    stack: prefix,
    stage: prefix,
    prefix,
    names: { accounts: `${prefix}-accounts`, inference: `${prefix}-inference`, gateway: `${prefix}-gateway`,
      ripgit: `${prefix}-ripgit`, database: `${prefix}-accounts`, storage: `${prefix}-storage` },
    handles,
    adminHost,
    adminOrigin: `https://${adminHost}`,
    gatewayHosts: handles.map((handle) => `${handle}.${input.domain}`),
    authCoverage: "synthetic operator transport; genuine Kernel credentials" as const,
    adapterCoverage: "none" as const,
    inferenceAllowed: false,
  };
}

export function assertUpgradeEnvironment(input: UpgradeFixture, environment: NodeJS.ProcessEnv, stage: string): void {
  const plan = upgradeFixturePlan(input);
  if (environment.CLOUDFLARE_ACCOUNT_ID !== input.accountId || environment.ALCHEMY_PROFILE !== input.profile
    || stage !== plan.stage) throw new Error("Upgrade fixture account, profile, and stage must all be explicit and match the reviewed plan");
}

export type ResourceIdentity = { kind: string; name: string; id: string };

/** A fixture cutover may add its new executor namespace, but never replace existing resources. */
export function assertUpgradeResourceContinuity(before: readonly ResourceIdentity[], after: readonly ResourceIdentity[], prefix: string): void {
  const identify = (resource: ResourceIdentity) => `${resource.kind}:${resource.name}`;
  const previous = new Map(before.map((resource) => [identify(resource), resource]));
  const next = new Map(after.map((resource) => [identify(resource), resource]));
  if (previous.size !== before.length || next.size !== after.length) throw new Error("Resource evidence has duplicate identities");
  for (const [key, resource] of previous) {
    if (next.get(key)?.id !== resource.id) throw new Error(`Existing resource changed: ${key}`);
  }
  for (const [key, resource] of next) {
    if (!previous.has(key) && !resource.name.startsWith(`${prefix}-`)) throw new Error(`Unrelated resource created: ${key}`);
  }
}
