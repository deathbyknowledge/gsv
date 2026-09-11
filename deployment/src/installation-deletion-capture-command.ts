import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captureInstallationDeletionObjects, cloudflareDeletionObjectPageSchema, deletionCaptureConfigurationSchema,
  deletionCaptureEpochSchema, deletionCaptureInspectionResultSchema, type DeletionCaptureAccounts,
  type DeletionCaptureArtifacts, type DeletionCaptureCloudflare } from "./installation-deletion-capture.ts";

type DeletionCaptureClients = { cloudflare: DeletionCaptureCloudflare; accounts: DeletionCaptureAccounts };

/** Tokens stay in request headers and memory. Redirects and response bodies never enter diagnostics. */
export function deletionCaptureClients(input: {
  accountId: string; accountsOrigin: string; cloudflareToken: string; operatorBearer?: string; operatorCookie?: string; fetch?: typeof fetch;
}): DeletionCaptureClients {
  const origin = new URL(input.accountsOrigin);
  if (!/^[a-f0-9]{32}$/.test(input.accountId) || origin.protocol !== "https:" || origin.origin !== input.accountsOrigin
    || !input.cloudflareToken.trim() || !(input.operatorBearer?.trim() || input.operatorCookie?.trim())) throw new Error("Capture requires explicit account, origin, and authentication");
  const transport = input.fetch ?? fetch;
  const request = async (url: string, options: RequestInit): Promise<string> => {
    let response: Response;
    try { response = await transport(url, { ...options, redirect: "error", signal: AbortSignal.timeout(60_000) }); }
    catch { throw new Error("Capture request failed; resume the saved artifacts after checking connectivity"); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Capture request returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Capture request returned an empty response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 512 * 1024) { void reader.cancel().catch(() => {}); throw new Error("Capture response exceeds the per-part limit"); }
        chunks.push(chunk.value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(body);
    } catch { throw new Error("Capture request returned invalid or oversized evidence"); }
    finally { reader.releaseLock(); }
  };
  const accountsHeaders = new Headers({ "Content-Type": "application/json", Origin: input.accountsOrigin });
  if (input.operatorBearer) accountsHeaders.set("Authorization", `Bearer ${input.operatorBearer}`);
  else accountsHeaders.set("Cookie", input.operatorCookie!);
  const endpoint = (installationId: string, action: string) => `${input.accountsOrigin}/admin/api/installations/${encodeURIComponent(installationId)}/deletion/${action}`;
  return {
    cloudflare: { async listObjects(parameters) {
      if (parameters.accountId !== input.accountId || !/^[a-f0-9]{32}$/.test(parameters.namespaceId)) throw new Error("Capture Cloudflare scope mismatch");
      const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/durable_objects/namespaces/${parameters.namespaceId}/objects`);
      url.searchParams.set("limit", String(parameters.limit));
      if (parameters.cursor) url.searchParams.set("cursor", parameters.cursor);
      return cloudflareDeletionObjectPageSchema.parse(JSON.parse(await request(url.toString(), { headers: { Authorization: `Bearer ${input.cloudflareToken}` } })));
    } },
    accounts: {
      openInspection: async (installationId) => deletionCaptureEpochSchema.parse(JSON.parse(await request(endpoint(installationId, "inspection"), { method: "POST", headers: accountsHeaders }))),
      inspect: async (parameters) => deletionCaptureInspectionResultSchema.parse(JSON.parse(await request(endpoint(parameters.installationId, "inspect"),
        { method: "POST", headers: accountsHeaders, body: JSON.stringify(parameters) }))),
    },
  };
}

/** Flat, non-symlink files with atomic create prevent interrupted writes from becoming saved evidence. */
export async function privateDeletionCaptureArtifacts(directory: string): Promise<DeletionCaptureArtifacts> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("Capture output must be a private directory with mode0700");
  const filename = (reference: string) => {
    if (!/^[a-z0-9-]+\.json$/.test(reference)) throw new Error("Capture artifact reference is invalid");
    return path.join(directory, reference);
  };
  const read = async (reference: string): Promise<string | null> => {
    let handle;
    try { handle = await open(filename(reference), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 512 * 1024) throw new Error("Capture artifact permissions or size are invalid");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  };
  return { read, async write(reference, body) {
    const previous = await read(reference);
    if (previous !== null) {
      if (previous !== body) throw new Error("Capture resume conflicts with existing artifacts; use a new output directory");
      return;
    }
    const temporary = path.join(directory, `.capture-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(body, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, filename(reference)); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || await read(reference) !== body) throw error;
    } finally { await unlink(temporary); }
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
  } };
}

export async function installationDeletionCaptureMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { config: { type: "string" }, output: { type: "string" } } });
  if (!values.config || !values.output) throw new Error("Use --config <operator-scope.json> --output <private-directory>");
  const configuration = deletionCaptureConfigurationSchema.parse(JSON.parse(await readFile(values.config, "utf8")));
  const clients = deletionCaptureClients({ accountId: configuration.accountId, accountsOrigin: configuration.accountsOrigin,
    cloudflareToken: process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "",
    operatorBearer: process.env.GSV_OPERATOR_BEARER, operatorCookie: process.env.GSV_OPERATOR_COOKIE });
  const artifacts = await privateDeletionCaptureArtifacts(path.resolve(values.output));
  const result = await captureInstallationDeletionObjects({ configuration, ...clients, artifacts });
  const summary = { scope: result.scope, outcome: result.outcome, installationId: result.installationId,
    inspectionEpochId: result.inspectionEpochId, indexReference: result.indexReference,
    storedObjects: result.storedObjects, unidentifiedObjects: result.unidentifiedObjects,
    evidence: result.evidence.map(({ reference, sha256 }) => ({ reference, sha256 })) };
  await artifacts.write("capture-result.json", JSON.stringify(summary));
  process.stdout.write(`${JSON.stringify({ scope: result.scope, outcome: result.outcome,
    storedObjects: result.storedObjects, unidentifiedObjects: result.unidentifiedObjects, artifacts: result.evidence.length })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await installationDeletionCaptureMain(); }
  catch {
    process.stderr.write("DO evidence capture did not complete. Existing private artifacts may be resumed with the same configuration. No inventory was registered and no erasure was started.\n");
    process.exitCode = 1;
  }
}
