import * as Cloudflare from "alchemy/Cloudflare";
import * as State from "alchemy/State";
import { RemovalPolicy } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GsvPreview, gsvPreviewPlan, gsvPreviewState, parseGsvPreviewConfig, parseGsvPreviewIdentity } from "../src/preview.ts";
import { gsvRuntimeDependencies, type GsvRuntimeDependencies } from "../src/runtime.ts";
import type { GsvDeploymentManifest } from "../src/manifest.ts";

const environment = {
  GSV_PREVIEW_REPOSITORY_ID: "12345",
  GSV_PREVIEW_NUMBER: "312",
  GSV_ALLOW_RESOURCE_DELETION: "true",
  GSV_PREVIEW_BASE_DOMAIN: "gsv-previews.example.com",
  GSV_PREVIEW_ZONE_ID: "a".repeat(32),
  GSV_PREVIEW_ZONE_NAME: "example.com",
  GSV_PREVIEW_ACCESS_TEAM_DOMAIN: "https://company.cloudflareaccess.com",
  GSV_PREVIEW_ACCESS_EMAIL_DOMAINS: "example.com, example.org, example.com",
  GSV_PREVIEW_ACCESS_EMAILS: "reviewer@partner.example",
};
const manifest: GsvDeploymentManifest = {
  version: 3,
  runtime: {
    gatewayBundle: "gateway.js", ripgitBundle: "ripgit.js", webAssets: "assets",
    installationsBundle: "installations.js", installationsMigrations: "migrations", inferenceBundle: "inference.js",
  },
  adapters: [],
};

type RecordedProps = {
  worker: Cloudflare.Workers.WorkerProps<Cloudflare.Workers.WorkerBindingProps>;
  d1: Cloudflare.D1.DatabaseProps;
  r2: Cloudflare.R2.BucketProps;
  dns: Cloudflare.DNS.RecordProps;
  route: Cloudflare.Workers.WorkerRouteProps;
  "access-policy": Cloudflare.Access.PolicyProps;
  "access-app": Cloudflare.Access.ApplicationProps;
  certificate: Cloudflare.Ssl.CertificatePackProps;
};
type RecordedResource = {
  [Kind in keyof RecordedProps]: { type: Kind; id: string; props: RecordedProps[Kind]; removalPolicy: string | undefined }
}[keyof RecordedProps];

function recorder() {
  const resources: RecordedResource[] = [];
  function resource<Kind extends keyof RecordedProps, A>(type: Kind, id: string, props: RecordedProps[Kind], attributes: A) {
    return Effect.gen(function* () {
      const removalPolicy = Option.getOrUndefined(yield* Effect.serviceOption(RemovalPolicy));
      // SAFETY: Kind constrains props to the matching entry in RecordedProps.
      resources.push({ type, id, props, removalPolicy } as RecordedResource);
      return attributes;
    });
  }
  const recordedCloudflare = {
    ...Cloudflare,
    Worker(id: string, props: RecordedProps["worker"]) {
      return resource("worker", id, props, {
        workerName: props.name,
        durableObjectNamespaces: { Kernel: "1".repeat(32), Process: "2".repeat(32), Conversation: "3".repeat(32), Repository: "4".repeat(32), InferenceExecutor: "5".repeat(32) },
        bind() { return Effect.void; },
      });
    },
    D1: { Database(id: string, props: RecordedProps["d1"]) { return resource("d1", id, props, { databaseId: "fixture-database" }); } },
    R2: { Bucket(id: string, props: RecordedProps["r2"]) { return resource("r2", id, props, { bucketName: props.name }); } },
    DNS: { Record(id: string, props: RecordedProps["dns"]) { return resource("dns", id, props, { id: "fixture-dns" }); } },
    Workers: {
      ...Cloudflare.Workers,
      WorkerRoute(id: string, props: RecordedProps["route"]) { return resource("route", id, props, { routeId: "fixture-route" }); },
    },
    Access: {
      Policy(id: string, props: RecordedProps["access-policy"]) { return resource("access-policy", id, props, { policyId: "fixture-policy" }); },
      Application(id: string, props: RecordedProps["access-app"]) {
        return resource("access-app", id, props, { applicationId: "fixture-application", aud: "fixture-access-audience" });
      },
    },
    Ssl: {
      CertificatePack(id: string, props: RecordedProps["certificate"]) { return resource("certificate", id, props, { certificatePackId: "fixture-certificate" }); },
    },
    DurableObject(binding: string, props: { className: string }) { return { binding, ...props }; },
    WorkerLoader() { return { kind: "loader" }; },
    WorkerEntrypoint() { return { kind: "entrypoint" }; },
  };
  // SAFETY: the recorder replaces every cloud resource constructor used by the
  // preview and retains the real removal-policy Effects; it never uses providers.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The recorder intentionally implements only the constructor and binding methods exercised here.
  const dependencies = { ...gsvRuntimeDependencies, Cloudflare: recordedCloudflare } as unknown as GsvRuntimeDependencies;
  return { resources, dependencies };
}

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  // SAFETY: composition tests inject only local resource recorders.
  return Effect.runPromise(effect as Effect.Effect<A, E>);
}

afterEach(() => vi.unstubAllGlobals());

describe("disposable pull request previews", () => {
  it("separates repository state and physical names while keeping a stable PR domain", () => {
    const config = parseGsvPreviewConfig(environment, "pr-312");
    const plan = gsvPreviewPlan(config, "pr-312");
    expect(plan).toMatchObject({
      repositoryId: "12345", pullRequest: 312, stack: "gsv-previews-12345", stage: "pr-312", prefix: "gsv-12345-pr-312",
      domain: "pr-312.gsv-previews.example.com", adminOrigin: "https://accounts.pr-312.gsv-previews.example.com",
      createInstallationUrl: "https://accounts.pr-312.gsv-previews.example.com/admin/installations/new",
    });
    const other = parseGsvPreviewIdentity({ ...environment, GSV_PREVIEW_REPOSITORY_ID: "56789" });
    expect(other.stack).not.toBe(plan.stack);
    expect(other.prefix).not.toBe(plan.prefix);
    expect(config.accessEmailDomains).toEqual(["example.com", "example.org"]);
    expect(parseGsvPreviewConfig({ ...environment, GSV_PREVIEW_INFERENCE_MODEL: "" }, "pr-312").inferenceModel).toBe(config.inferenceModel);
  });

  it.each([undefined, "false", "TRUE", "1"])("requires explicit deletion permission: %s", (value) => {
    expect(() => parseGsvPreviewConfig({ ...environment, GSV_ALLOW_RESOURCE_DELETION: value }, "pr-312"))
      .toThrow(/explicitly equal true/);
  });

  it.each(["", "0", "-1", "01", "1.5", "1e3", "9007199254740992"])("rejects unsafe preview identifiers: %s", (value) => {
    expect(() => parseGsvPreviewIdentity({ ...environment, GSV_PREVIEW_NUMBER: value })).toThrow(/positive decimal/);
    expect(() => parseGsvPreviewIdentity({ ...environment, GSV_PREVIEW_REPOSITORY_ID: value })).toThrow(/positive decimal/);
  });

  it("rejects mismatched stages and forged production names before declaring resources", () => {
    expect(() => parseGsvPreviewConfig(environment, "production")).toThrow(/must match/);
    const config = parseGsvPreviewConfig(environment, "pr-312");
    const { dependencies, resources } = recorder();
    expect(() => GsvPreview({ config: { ...config, prefix: "gsv" }, stage: config.stage, manifest }, dependencies)).toThrow(/must match/);
    expect(resources).toEqual([]);
  });

  it.each([
    { GSV_PREVIEW_BASE_DOMAIN: "another.example.net" },
    { GSV_PREVIEW_BASE_DOMAIN: "*.example.com" },
    { GSV_PREVIEW_ACCESS_EMAIL_DOMAINS: "", GSV_PREVIEW_ACCESS_EMAILS: "" },
    { GSV_PREVIEW_ACCESS_EMAIL_DOMAINS: "*.example.com" },
    { GSV_PREVIEW_ACCESS_EMAILS: "*@example.com" },
    { GSV_PREVIEW_ACCESS_TEAM_DOMAIN: "http://company.cloudflareaccess.com" },
    { GSV_PREVIEW_ZONE_ID: "invalid" },
    { GSV_PREVIEW_INFERENCE_MODEL: "external-provider-model" },
  ])("rejects invalid routing and access configuration: %j", (change) => {
    expect(() => parseGsvPreviewConfig({ ...environment, ...change }, "pr-312")).toThrow();
  });

  it("composes the public installation stack with exact admin Access, nested TLS and owned deletion", async () => {
    const config = parseGsvPreviewConfig(environment, "pr-312");
    const { dependencies, resources } = recorder();
    const output = await run(GsvPreview({ config, stage: config.stage, manifest }, dependencies));
    expect(resources.every((entry) => entry.removalPolicy === "destroy")).toBe(true);
    expect(resources.map((entry) => entry.type).sort()).toEqual([
      "access-app", "access-policy", "certificate", "d1", "dns", "r2", "route", "route", "worker", "worker", "worker", "worker",
    ]);
    expect(resources.find((entry) => entry.type === "access-app")?.props).toMatchObject({
      name: "gsv-12345-pr-312-administration", domain: "accounts.pr-312.gsv-previews.example.com", policies: ["fixture-policy"], type: "self_hosted",
    });
    expect(resources.find((entry) => entry.type === "access-policy")?.props).toMatchObject({
      decision: "allow", include: [{ emailDomain: { domain: "example.com" } }, { emailDomain: { domain: "example.org" } }, { email: { email: "reviewer@partner.example" } }],
    });
    expect(resources.find((entry) => entry.type === "certificate")?.props).toMatchObject({
      hosts: ["example.com", "pr-312.gsv-previews.example.com", "*.pr-312.gsv-previews.example.com"],
      certificateAuthority: "google", validationMethod: "txt", validityDays: 90,
    });
    expect(resources.filter((entry) => entry.type === "route").map((entry) => entry.props)).toEqual([
      { zoneId: environment.GSV_PREVIEW_ZONE_ID, pattern: "accounts.pr-312.gsv-previews.example.com/*", script: "gsv-12345-pr-312-installations" },
      { zoneId: environment.GSV_PREVIEW_ZONE_ID, pattern: "*.pr-312.gsv-previews.example.com/*", script: "gsv-12345-pr-312" },
    ]);
    const workers = resources.filter((entry) => entry.type === "worker");
    const accounts = workers.find((entry) => entry.id === "PreviewInstallations")!.props.env;
    expect(accounts).toMatchObject({ GSV_OPERATOR_ACCESS_MODE: "access", GSV_ADMIN_ACCESS_AUD: "fixture-access-audience" });
    expect(accounts).not.toHaveProperty("GSV_OWNER_AUTH_SECRET");
    expect(workers.find((entry) => entry.id === "PreviewInference")!.props.env).toMatchObject({ INFERENCE_DEFAULT_PROVIDER: "workers-ai" });
    expect(workers.find((entry) => entry.id === "PreviewInference")!.props.env).not.toHaveProperty("INFERENCE_API_KEY");
    expect(workers.every((entry) => entry.props.workersDev === false)).toBe(true);
    expect(output).toMatchObject({ databaseId: "fixture-database", accessApplicationId: "fixture-application", accessPolicyId: "fixture-policy", certificatePackId: "fixture-certificate" });
  });

  it("uses the same explicit HTTP state API without bootstrapping a cloud store", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ version: 5 }), { headers: { "content-type": "application/json" } });
    });
    const version = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* yield* State.State;
      return yield* store.getVersion();
    }).pipe(
      Effect.provide(gsvPreviewState({ ALCHEMY_STATE_URL: "https://preview-state.example.com", ALCHEMY_STATE_TOKEN: "synthetic-state-token" })),
      Effect.provide(FetchHttpClient.layer),
    ));
    expect(version).toBe(5);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://preview-state.example.com/version");
    expect(requests[0].headers.get("authorization")).toBe("Bearer synthetic-state-token");
    expect(() => gsvPreviewState({})).toThrow(/ALCHEMY_STATE_URL/);
    expect(() => gsvPreviewState({ ALCHEMY_STATE_URL: "http://preview-state.example.com", ALCHEMY_STATE_TOKEN: "synthetic" })).toThrow(/HTTPS/);
    expect(() => gsvPreviewState({ ALCHEMY_STATE_URL: "https://preview-state.example.com" })).toThrow(/ALCHEMY_STATE_TOKEN/);
  });
});
