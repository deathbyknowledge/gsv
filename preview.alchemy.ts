import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { GsvDeployment } from "./deployment/src/installation.ts";
import { gsvRuntimeManifestSchema } from "./deployment/src/manifest.ts";

const repositoryId = z.string().regex(/^[1-9][0-9]{0,14}$/).parse(process.env.GSV_PREVIEW_REPOSITORY_ID);
const pullRequest = z.string().regex(/^[1-9][0-9]{0,14}$/).parse(process.env.GSV_PREVIEW_NUMBER);
const prefix = `gsv-${repositoryId}-pr-${pullRequest}`;
// These tracked paths can be read on destroy without building or downloading the Workers.
const { runtime } = gsvRuntimeManifestSchema.parse(JSON.parse(readFileSync(new URL("./deployment/runtime.json", import.meta.url), "utf8")));
const hostname = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

export default Alchemy.Stack(`gsv-previews-${repositoryId}`, {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
}, Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== `pr-${pullRequest}`) throw new Error("Preview stage must match the pull request");
  const baseDomain = hostname.parse(yield* Config.string("GSV_PREVIEW_BASE_DOMAIN"));
  const zoneName = hostname.parse(yield* Config.string("GSV_PREVIEW_ZONE_NAME"));
  const zoneId = z.string().regex(/^[a-f0-9]{32}$/).parse(yield* Config.string("GSV_PREVIEW_ZONE_ID"));
  if (baseDomain !== zoneName && !baseDomain.endsWith(`.${zoneName}`)) {
    throw new Error("Preview base domain must belong to its configured zone");
  }
  const domain = `pr-${pullRequest}.${baseDomain}`;
  const adminOrigin = `https://accounts.${domain}`;
  const teamDomain = yield* Config.string("GSV_PREVIEW_ACCESS_TEAM_DOMAIN");
  const domains = (yield* Config.string("GSV_PREVIEW_ACCESS_EMAIL_DOMAINS").pipe(Config.withDefault("")))
    .split(",").map((value) => value.trim()).filter(Boolean).map((value) => hostname.parse(value));
  const emails = (yield* Config.string("GSV_PREVIEW_ACCESS_EMAILS").pipe(Config.withDefault("")))
    .split(",").map((value) => value.trim()).filter(Boolean).map((value) => z.email().parse(value));
  if (domains.length + emails.length === 0) throw new Error("Preview Access requires permitted email domains or addresses");
  const allowResourceDeletion = z.enum(["false", "true"]).parse(
    yield* Config.string("GSV_ALLOW_RESOURCE_DELETION").pipe(Config.withDefault("false")),
  ) === "true";
  const model = (yield* Config.string("GSV_PREVIEW_INFERENCE_MODEL").pipe(Config.withDefault(""))) || "@cf/zai-org/glm-5.3-flash";
  z.string().regex(/^@cf\/[a-z0-9._/-]+$/).parse(model);

  const policy = yield* Cloudflare.Access.Policy("PreviewAccessPolicy", {
    name: `${prefix}-company`, decision: "allow", sessionDuration: "24h",
    include: [...domains.map((domain) => ({ emailDomain: { domain } })), ...emails.map((email) => ({ email: { email } }))],
  }).pipe(retain(!allowResourceDeletion));
  const application = yield* Cloudflare.Access.Application("PreviewAccessApplication", {
    name: `${prefix}-administration`, type: "self_hosted", domain: `accounts.${domain}`,
    policies: [policy.policyId], sessionDuration: "24h", appLauncherVisible: false,
  }).pipe(retain(!allowResourceDeletion));
  // Nested space names need their own wildcard certificate and a zone with full DNS setup.
  yield* Cloudflare.Ssl.CertificatePack("PreviewCertificate", {
    zoneId, hosts: [zoneName, domain, `*.${domain}`], certificateAuthority: "google",
    validationMethod: "txt", validityDays: 90, cloudflareBranding: true,
  }).pipe(retain(!allowResourceDeletion));
  const deployment = yield* GsvDeployment({
    logicalPrefix: "Preview", allowResourceDeletion, domain, adminOrigin,
    access: { kind: "cloudflare-access", teamDomain, audience: application.aud },
    routing: { zoneId },
    names: { gateway: prefix, ripgit: `${prefix}-ripgit`, storageBucket: `${prefix}-storage` },
    paths: runtime,
    observability: { enabled: true, logs: { enabled: true, invocationLogs: false, persist: false }, traces: { enabled: false } },
    installations: {
      workerName: `${prefix}-installations`, databaseName: `${prefix}-installations`,
      workerBundle: runtime.installationsBundle, migrationsDirectory: runtime.installationsMigrations,
    },
    inference: {
      workerName: `${prefix}-inference`, workerBundle: runtime.inferenceBundle,
      defaultProvider: "workers-ai", defaultModel: model,
      monthlyRequests: 1_000, monthlyOutputTokens: 1_000_000, maxOutputTokens: 8_192, maxDurationMs: 180_000,
    },
  });
  return { administration: `${adminOrigin}/admin/installations`, gateway: deployment.gateway.workerName };
}));
