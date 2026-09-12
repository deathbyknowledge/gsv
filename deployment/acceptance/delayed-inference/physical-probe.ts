import { z } from "zod";

const resourceSchema = z.strictObject({
  ownerId: z.enum(["gateway", "inference"]),
  kind: z.enum(["kernel", "process", "conversation", "ripgit", "inference-executor"]),
  namespaceId: z.string().regex(/^[a-f0-9]{32}$/), objectId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  name: z.string().min(1).max(1024),
});
export const physicalScopeSchema = z.strictObject({
  installationId: z.string().regex(/^inst_[a-f0-9-]{36}$/), operationId: z.string().uuid(),
  resources: z.array(resourceSchema).min(4).max(32),
});
export const physicalRequestSchema = z.strictObject({ installationId: z.string(), operationId: z.string().uuid() });
type PhysicalRequest = z.infer<typeof physicalRequestSchema>;
type PhysicalStub = {
  inspectInstallationResource(): Promise<{ name?: string; empty: boolean }>;
  installationDeletionStatus(input: PhysicalRequest): Promise<{ installationId: string; operationId: string; phase: string; pendingResources: number }>;
  fetch(request: Request): Promise<Response>;
};
type PhysicalNamespace = {
  idFromName(name: string): { toString(): string };
  getByName(name: string): PhysicalStub;
};
export type PhysicalEnvironment = {
  DELAY_INSTALLATION_ID?: string;
  DELAY_PROCESS_ID?: string;
  PHYSICAL_SCOPE?: string;
  PHYSICAL_KERNEL?: PhysicalNamespace;
  PHYSICAL_PROCESS?: PhysicalNamespace;
  PHYSICAL_CONVERSATION?: PhysicalNamespace;
  PHYSICAL_REPOSITORY?: PhysicalNamespace;
  PHYSICAL_INFERENCE_EXECUTORS?: PhysicalNamespace;
};

/** Acceptance-only reads of existing owner methods; callers cannot supply an address. */
export async function inspectPhysicalResources(env: PhysicalEnvironment, input: PhysicalRequest) {
  const scope = physicalScopeSchema.parse(JSON.parse(z.string().parse(env.PHYSICAL_SCOPE)));
  const processId = env.DELAY_PROCESS_ID;
  if (scope.installationId !== env.DELAY_INSTALLATION_ID || !processId
    || !scope.resources.some((resource) => resource.kind === "process"
      && resource.name === `process:${encodeURIComponent(scope.installationId)}:${encodeURIComponent(processId)}`)) {
    throw new Error("Physical scope does not match the selected Process");
  }
  const request = z.strictObject({ installationId: z.literal(scope.installationId), operationId: z.literal(scope.operationId) }).parse(input);
  const namespaces = { kernel: env.PHYSICAL_KERNEL, process: env.PHYSICAL_PROCESS, conversation: env.PHYSICAL_CONVERSATION,
    ripgit: env.PHYSICAL_REPOSITORY, "inference-executor": env.PHYSICAL_INFERENCE_EXECUTORS };
  const seen = new Set<string>();
  const kinds = new Set<string>(scope.resources.map((resource) => resource.kind));
  if (!["kernel", "process", "conversation", "inference-executor"].every((kind) => kinds.has(kind))) {
    throw new Error("Physical scope lacks the original inference resources");
  }
  // Validate the COMPLETE list before opening any object, including physical/name correspondence.
  const resources = scope.resources.map((resource) => {
    const namespace = namespaces[resource.kind];
    const { installationId } = scope;
    const prefix = `${resource.kind}:${encodeURIComponent(installationId)}:`;
    const nameAllowed = resource.kind === "kernel" || resource.kind === "inference-executor" ? resource.name === installationId
      : resource.kind === "ripgit" ? resource.name === `installation-index:${installationId}` || resource.name.startsWith(`${installationId}/`)
      : resource.name.startsWith(prefix) && resource.name.length > prefix.length;
    if (!namespace || !nameAllowed || resource.ownerId !== (resource.kind === "inference-executor" ? "inference" : "gateway")) {
      throw new Error("Physical resource is outside the configured installation");
    }
    const physicalId = namespace.idFromName(resource.name).toString();
    const key = `${resource.namespaceId}:${physicalId}`;
    if (!/^[a-f0-9]{64}$/.test(physicalId) || (resource.objectId && resource.objectId !== physicalId) || seen.has(key)) {
      throw new Error("Physical resource address does not match the reviewed scope");
    }
    seen.add(key);
    return { resource, namespace, physicalId };
  });
  const observations = [];
  for (const { resource, namespace, physicalId } of resources) {
    const stub = namespace.getByName(resource.name);
    let liveCount: number;
    const measurement = resource.kind === "inference-executor" ? "executor-row-and-active-count" : "application-nonempty-indicator";
    if (resource.kind === "inference-executor") {
      const status = z.object({ installationId: z.literal(scope.installationId), operationId: z.literal(scope.operationId),
        phase: z.enum(["live-erased", "erased"]), pendingResources: z.number().int().nonnegative() }).parse(await stub.installationDeletionStatus(request));
      liveCount = status.pendingResources;
    } else {
      let raw: unknown;
      if (resource.kind === "ripgit") {
        const response = await stub.fetch(new Request("https://ripgit.invalid/.gsv/resource/inspect"));
        if (!response.ok) { await response.body?.cancel(); throw new Error("Physical repository inspection failed"); }
        raw = await response.json();
      } else raw = await stub.inspectInstallationResource();
      const result = z.object({ name: z.literal(resource.name), empty: z.boolean() }).parse(raw);
      liveCount = result.empty ? 0 : 1;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(resource.name)));
    observations.push({ ownerId: resource.ownerId, kind: resource.kind, namespaceId: resource.namespaceId, physicalId,
      nameSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""), liveCount, measurement });
  }
  const receipt = { ...request, observedAt: Date.now(), tombstonesExcluded: true, resources: observations,
    liveResources: observations.reduce((sum, resource) => sum + resource.liveCount, 0) };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(receipt))));
  return { ...receipt, sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") };
}
