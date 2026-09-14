import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as State from "alchemy/State";
import { GsvDeployment } from "./installation.ts";
import type { GsvDeploymentManifest } from "./manifest.ts";
import { gsvRuntimeDependencies } from "./runtime.ts";

export const GSV_PREVIEW_INFERENCE_MODEL = "@cf/zai-org/glm-5.3-flash";

type PreviewEnvironment = Readonly<Record<string, string | undefined>>;

export type GsvPreviewIdentity = {
  repositoryId: string;
  pullRequest: number;
  stack: string;
  stage: string;
  prefix: string;
};

export type GsvPreviewConfig = GsvPreviewIdentity & {
  allowResourceDeletion: true;
  baseDomain: string;
  zoneId: string;
  zoneName: string;
  accessTeamDomain: string;
  accessEmailDomains: string[];
  accessEmails: string[];
  inferenceModel: string;
};

function positiveDecimal(value: string | undefined, name: string): string {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  return value;
}

function hostname(value: string | undefined, name: string): string {
  if (!value || value.length > 253 || !value.includes(".")
    || value.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error(`${name} must be a lowercase DNS hostname without wildcards`);
  }
  return value;
}

export function parseGsvPreviewIdentity(environment: PreviewEnvironment): GsvPreviewIdentity {
  const repositoryId = positiveDecimal(environment.GSV_PREVIEW_REPOSITORY_ID, "GSV_PREVIEW_REPOSITORY_ID");
  const number = positiveDecimal(environment.GSV_PREVIEW_NUMBER, "GSV_PREVIEW_NUMBER");
  return {
    repositoryId,
    pullRequest: Number(number),
    stack: `gsv-previews-${repositoryId}`,
    stage: `pr-${number}`,
    prefix: `gsv-${repositoryId}-pr-${number}`,
  };
}

export function parseGsvPreviewConfig(environment: PreviewEnvironment, stage: string): GsvPreviewConfig {
  if (environment.GSV_ALLOW_RESOURCE_DELETION !== "true") {
    throw new Error("GSV_ALLOW_RESOURCE_DELETION must explicitly equal true for disposable previews");
  }
  const csv = (value: string | undefined) => [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  const config: GsvPreviewConfig = {
    ...parseGsvPreviewIdentity(environment),
    allowResourceDeletion: true,
    baseDomain: environment.GSV_PREVIEW_BASE_DOMAIN ?? "",
    zoneId: environment.GSV_PREVIEW_ZONE_ID ?? "",
    zoneName: environment.GSV_PREVIEW_ZONE_NAME ?? "",
    accessTeamDomain: environment.GSV_PREVIEW_ACCESS_TEAM_DOMAIN ?? "",
    accessEmailDomains: csv(environment.GSV_PREVIEW_ACCESS_EMAIL_DOMAINS),
    accessEmails: csv(environment.GSV_PREVIEW_ACCESS_EMAILS),
    inferenceModel: environment.GSV_PREVIEW_INFERENCE_MODEL || GSV_PREVIEW_INFERENCE_MODEL,
  };
  gsvPreviewPlan(config, stage);
  return config;
}

export function gsvPreviewState(environment: PreviewEnvironment) {
  const url = environment.ALCHEMY_STATE_URL;
  const authToken = environment.ALCHEMY_STATE_TOKEN;
  if (!url || !URL.canParse(url)) throw new Error("ALCHEMY_STATE_URL must be an explicit HTTPS state store origin");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== url || parsed.username || parsed.password) {
    throw new Error("ALCHEMY_STATE_URL must be an explicit HTTPS state store origin");
  }
  if (!authToken?.trim()) throw new Error("ALCHEMY_STATE_TOKEN is required for the preview state store");
  return Layer.effect(State.State, State.makeHttpStateStore({ url, authToken, id: "http" }).pipe(Effect.map(Effect.succeed)));
}

export function gsvPreviewPlan(config: GsvPreviewConfig, stage: string) {
  if (config.allowResourceDeletion !== true) throw new Error("Previews require explicit allowResourceDeletion: true");
  const identity = parseGsvPreviewIdentity({
    GSV_PREVIEW_REPOSITORY_ID: config.repositoryId,
    GSV_PREVIEW_NUMBER: String(config.pullRequest),
  });
  if (stage !== identity.stage || config.stage !== identity.stage || config.stack !== identity.stack || config.prefix !== identity.prefix) {
    throw new Error("Preview stack, stage and resource prefix must match its repository and pull request");
  }
  const baseDomain = hostname(config.baseDomain, "GSV_PREVIEW_BASE_DOMAIN");
  const zoneName = hostname(config.zoneName, "GSV_PREVIEW_ZONE_NAME");
  if (baseDomain !== zoneName && !baseDomain.endsWith(`.${zoneName}`)) {
    throw new Error("The preview base domain must belong to its configured DNS zone");
  }
  if (!/^[a-f0-9]{32}$/.test(config.zoneId)) throw new Error("GSV_PREVIEW_ZONE_ID must be a Cloudflare zone ID");
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.accessTeamDomain)) {
    throw new Error("GSV_PREVIEW_ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access team origin");
  }
  for (const domain of config.accessEmailDomains) hostname(domain, "Access email domain");
  for (const email of config.accessEmails) {
    const parts = email.split("@");
    if (parts.length !== 2 || !/^[a-zA-Z0-9.!#$%&'+/=?^_`{|}~-]+$/.test(parts[0])) {
      throw new Error("Access email addresses must be exact email addresses");
    }
    hostname(parts[1], "Access email address domain");
  }
  if (config.accessEmailDomains.length + config.accessEmails.length === 0) {
    throw new Error("Previews require at least one allowed Access email domain or email address");
  }
  if (!config.inferenceModel.startsWith("@cf/") || /\s/.test(config.inferenceModel)) {
    throw new Error("GSV_PREVIEW_INFERENCE_MODEL must name a Workers AI model");
  }
  const domain = hostname(`${identity.stage}.${baseDomain}`, "Preview domain");
  const adminHostname = hostname(`accounts.${domain}`, "Preview administration hostname");
  return {
    ...identity,
    domain,
    adminHostname,
    adminOrigin: `https://${adminHostname}`,
    createInstallationUrl: `https://${adminHostname}/admin/installations/new`,
    zoneId: config.zoneId,
    zoneName,
    names: {
      gateway: identity.prefix,
      ripgit: `${identity.prefix}-ripgit`,
      installations: `${identity.prefix}-installations`,
      inference: `${identity.prefix}-inference`,
      database: `${identity.prefix}-installations`,
      storageBucket: `${identity.prefix}-storage`,
      accessApplication: `${identity.prefix}-administration`,
      accessPolicy: `${identity.prefix}-company`,
    },
    certificateHosts: [zoneName, domain, `*.${domain}`],
  };
}

export type GsvPreviewProps = {
  config: GsvPreviewConfig;
  stage: string;
  manifest: GsvDeploymentManifest;
};

export const GsvPreview = (props: GsvPreviewProps, dependencies = gsvRuntimeDependencies) => {
  const plan = gsvPreviewPlan(props.config, props.stage);
  const { Cloudflare, retain } = dependencies;
  return Effect.gen(function* () {
    const policy = yield* Cloudflare.Access.Policy("PreviewAccessPolicy", {
      name: plan.names.accessPolicy,
      decision: "allow",
      include: [
        ...props.config.accessEmailDomains.map((domain) => ({ emailDomain: { domain } })),
        ...props.config.accessEmails.map((email) => ({ email: { email } })),
      ],
      sessionDuration: "24h",
    }).pipe(retain(false));
    const application = yield* Cloudflare.Access.Application("PreviewAccessApplication", {
      name: plan.names.accessApplication,
      type: "self_hosted",
      domain: plan.adminHostname,
      policies: [policy.policyId],
      sessionDuration: "24h",
      appLauncherVisible: false,
    }).pipe(retain(false));
    // The preview zone must use full DNS setup so Cloudflare owns TXT validation.
    // Issuance is asynchronous; the preview driver checks active status and TLS.
    const certificate = yield* Cloudflare.Ssl.CertificatePack("PreviewCertificate", {
      zoneId: props.config.zoneId,
      hosts: plan.certificateHosts,
      certificateAuthority: "google",
      validationMethod: "txt",
      validityDays: 90,
      cloudflareBranding: true,
    }).pipe(retain(false));
    const deployment = yield* GsvDeployment({
      logicalPrefix: "Preview",
      allowResourceDeletion: props.config.allowResourceDeletion,
      domain: plan.domain,
      adminOrigin: plan.adminOrigin,
      access: { kind: "cloudflare-access", teamDomain: props.config.accessTeamDomain, audience: application.aud },
      routing: { zoneId: props.config.zoneId },
      names: plan.names,
      paths: props.manifest.runtime,
      observability: { enabled: true, logs: { enabled: true, invocationLogs: false, persist: false }, traces: { enabled: false } },
      installations: {
        workerName: plan.names.installations,
        databaseName: plan.names.database,
        workerBundle: props.manifest.runtime.installationsBundle,
        migrationsDirectory: props.manifest.runtime.installationsMigrations,
      },
      inference: {
        workerName: plan.names.inference,
        workerBundle: props.manifest.runtime.inferenceBundle,
        defaultProvider: "workers-ai",
        defaultModel: props.config.inferenceModel,
        monthlyRequests: 1_000,
        monthlyOutputTokens: 1_000_000,
        maxOutputTokens: 8_192,
        maxDurationMs: 180_000,
      },
    }, dependencies);
    return {
      ...plan,
      databaseId: deployment.database!.databaseId,
      accessApplicationId: application.applicationId,
      accessPolicyId: policy.policyId,
      certificatePackId: certificate.certificatePackId,
    };
  });
};
