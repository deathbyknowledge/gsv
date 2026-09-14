import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { GSVClient, GsvClientError, type GsvWebSocketConstructor } from "@humansandmachines/gsv/client";
import { z } from "zod";
import { cloudLifecycleReport, lifecycleConfigurationSchema, lifecycleCredentialsSchema, lifecycleDeletionSchema,
  lifecycleDigest, lifecycleInstallationSchema, lifecycleIssuedSchema, lifecycleRowSchema, lifecycleStateSchema,
  prepareCloudLifecycle, runCloudLifecycle, type LifecycleConfiguration, type LifecycleDependencies, type LifecycleGateway, type LifecycleState, type LifecycleJson } from "./cloud-lifecycle-acceptance.ts";

class AcceptanceWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, { headers: { "user-agent": "gsv-acceptance/1.0" } });
  }
}
const nodeWebSocketConstructor: unknown = AcceptanceWebSocket;
// SAFETY: ws supplies the client socket API. Deployment typechecking also loads Cloudflare server-only WebSocket methods.
const acceptanceWebSocket = nodeWebSocketConstructor as GsvWebSocketConstructor;
async function privateJson(filename: string, value: LifecycleJson): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.next`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function privateText(filename: string): Promise<string> {
  const info = await lstat(filename);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Input must be a private owned regular file");
  return readFile(filename, "utf8");
}
async function json(filename: string): Promise<LifecycleJson> { return z.json().parse(JSON.parse(await privateText(filename))); }
async function request(url: string, headers: Record<string, string>, body?: LifecycleJson): Promise<LifecycleJson> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(45_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Acceptance HTTP request failed (${response.status})`); }
  return z.json().parse(await response.json());
}
function wsUrl(origin: string): string { const url = new URL("/ws", origin); url.protocol = "wss:"; return url.toString(); }
async function connected<T>(gateway: LifecycleGateway, action: (client: GSVClient) => Promise<T>, root = false): Promise<T> {
  const client = new GSVClient({ WebSocket: acceptanceWebSocket, defaultRequestTimeoutMs: 45_000 });
  try {
    await client.connect({ url: wsUrl(gateway.origin), username: root ? "root" : gateway.credentials.username,
      password: root ? gateway.credentials.rootPassword : gateway.credentials.password,
      peer: { id: "cloud-lifecycle-acceptance", version: "1", platform: "acceptance" } });
    return await action(client);
  } finally { client.disconnect(); }
}
export function cloudLifecycleDependencies(input: { configuration: LifecycleConfiguration; operatorToken: string; cloudflareToken: string; directory: string }): LifecycleDependencies {
  const { configuration: config } = input;
  const admin = (suffix: string, body?: LifecycleJson) => request(config.accountsOrigin + "/admin/api/installations" + suffix,
    { authorization: `Bearer ${input.operatorToken}`, origin: config.accountsOrigin, "content-type": "application/json" }, body);
  const cloud = async (suffix: string, body?: LifecycleJson) => {
    const result = z.object({ success: z.literal(true), result: z.json() }).parse(await request(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}${suffix}`,
      { authorization: `Bearer ${input.cloudflareToken}`, "content-type": "application/json" }, body));
    return result.result;
  };
  return {
    async snapshot() {
      const settings = z.object({ bindings: z.array(z.object({ type: z.string(), name: z.string(), database_id: z.string().optional() })) })
        .parse(await cloud(`/workers/scripts/${encodeURIComponent(config.accountsWorker)}/settings`));
      if (!settings.bindings.some((binding) => binding.type === "d1" && binding.name === "INSTALLATIONS_DB" && binding.database_id === config.databaseId)) {
        throw new Error("Reviewed account/worker/database binding does not match");
      }
      const result = z.array(z.object({ results: z.array(lifecycleRowSchema) })).length(1).parse(await cloud(
        `/d1/database/${encodeURIComponent(config.databaseId)}/query`, { sql: "SELECT id, handle, state FROM installations ORDER BY id" }));
      return result[0].results;
    },
    async installation(id) { return lifecycleInstallationSchema.parse(await admin(`/${encodeURIComponent(id)}`)); },
    async history(gateway) {
      return connected(gateway, async (client) => {
        const { conversations } = z.object({ conversations: z.array(z.object({ id: z.string() })) }).parse(await client.call("conversation.list", {}));
        const records: { id: string; sha256: string; messages: number }[] = [];
        for (const conversation of [...conversations].sort((a, b) => a.id.localeCompare(b.id))) {
          const messages: LifecycleJson[] = [];
          let beforeSequence: number | undefined;
          for (;;) {
            const page = z.object({ hasMore: z.boolean(), messages: z.array(z.object({ sequence: z.number() }).catchall(z.json())) })
              .parse(await client.call("conversation.history", { conversationId: conversation.id, limit: 100, beforeSequence }));
            messages.push(...page.messages.map((message) => z.json().parse(message)));
            if (!page.hasMore) break;
            const next = Math.min(...page.messages.map((message) => message.sequence));
            if (!page.messages.length || (beforeSequence !== undefined && next >= beforeSequence)) throw new Error("Conversation pagination made no progress");
            beforeSequence = next;
          }
          records.push({ id: conversation.id, sha256: lifecycleDigest(messages), messages: messages.length });
        }
        return lifecycleDigest(records);
      });
    },
    async read(gateway, filename) {
      return connected(gateway, async (client) => {
        const response = await client.request("fs.read", { path: filename, representation: "content", maxBytes: 4096 });
        const result = response.data;
        if (!result.ok) {
          await response.body?.stream.cancel();
          if (result.error.startsWith("ENOENT:")) return null;
          throw new Error("Acceptance marker read failed");
        }
        if (!("kind" in result) || result.kind !== "text" || result.truncated || !response.body) {
          await response.body?.stream.cancel();
          throw new Error("Acceptance marker must be a small text file");
        }
        const reader = response.body.stream.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
            if (length > 4096) throw new Error("Acceptance marker exceeded its size limit"); chunks.push(part.value); }
          return Buffer.concat(chunks).toString("utf8");
        } finally { await reader.cancel(); reader.releaseLock(); }
      });
    },
    async write(gateway, filename, content) { await connected(gateway, async (client) => {
      const result = await client.call("fs.write", { path: filename, content });
      if (!result.ok) throw new Error("Acceptance marker write failed");
    }); },
    async login(gateway, root) { try { return await connected(gateway, async () => true, root); }
      catch (error) { if (error instanceof GsvClientError && error.code === 401) return false; throw error; } },
    async reset(id, operationId, confirmHandle) { return lifecycleIssuedSchema.parse(await admin(`/${encodeURIComponent(id)}/reset`, { operationId, confirmHandle })); },
    async setup(gateway, token) {
      const client = new GSVClient({ WebSocket: acceptanceWebSocket, defaultRequestTimeoutMs: 60_000 });
      try { await client.requestOnce(wsUrl(gateway.origin), "sys.setup", { ...gateway.credentials, onboardingToken: token, agentName: "algo" }); }
      finally { client.disconnect(); }
    },
    async retire(id, operationId, confirmHandle) { await admin(`/${encodeURIComponent(id)}/deletion/retire`, { operationId, confirmHandle }); },
    async deletion(action, id, operationId, inventorySha256) {
      const suffix = `/${encodeURIComponent(id)}/deletion${action === "deletion-retry" ? "/retry" : ""}`;
      return lifecycleDeletionSchema.parse(await admin(suffix, action === "deletion-status" ? undefined
        : action === "deletion-retry" ? {} : { operationId, inventorySha256 }));
    },
    async save(state) { await privateJson(path.join(input.directory, "state.json"), state); await privateJson(path.join(input.directory, "report.json"), cloudLifecycleReport(state)); },
  };
}

export async function cloudLifecycleMain(args = process.argv.slice(2)): Promise<void> {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: "string" }, fixtures: { type: "string" }, operator: { type: "string" }, "cloudflare-token": { type: "string" },
    output: { type: "string" }, approve: { type: "string" }, "inventory-sha256": { type: "string" },
  } });
  const action = z.enum(["prepare", "seed", "reset", "setup", "verify", "retire", "delete", "deletion-status", "deletion-retry"]).parse(positionals[0]);
  if (positionals.length !== 1 || !values.config || !values.operator || !values.output || !values["cloudflare-token"] || (action === "prepare" && !values.fixtures)) {
    throw new Error("Use <phase> --config <scope.json> --operator <operator.json> --cloudflare-token <file> --output <private-directory> [--fixtures <fixture.json>] [--approve <prepared-digest>] [--inventory-sha256 <reviewed-digest>]");
  }
  const configuration = lifecycleConfigurationSchema.parse(await json(values.config));
  const operator = z.object({ origin: z.string(), token: z.string().min(1) }).parse(await json(values.operator));
  if (operator.origin !== configuration.accountsOrigin) throw new Error("Operator origin differs from the reviewed target");
  const directory = path.resolve(values.output);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Output must be a private owned directory (0700)");
  const lockPath = path.join(directory, "run.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, action })); await lock.sync();
    const deps = cloudLifecycleDependencies({ configuration, operatorToken: operator.token,
      cloudflareToken: (await privateText(values["cloudflare-token"])).trim(), directory });
    const statePath = path.join(directory, "state.json");
    let state: LifecycleState;
    if (action === "prepare") {
      try { await readFile(statePath); throw new Error("Acceptance state already exists; resume its recorded phase"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      const fixtures = z.object({ spaces: z.array(lifecycleCredentialsSchema.extend({ installationId: z.string(), handle: z.string(), canonicalOrigin: z.string() }).passthrough()) }).parse(await json(values.fixtures!));
      const credentials = Object.fromEntries((["a", "b"] as const).map((key) => {
        const expected = configuration.fixtures[key];
        const match = fixtures.spaces.filter((space) => space.installationId === expected.installationId && space.handle === expected.handle && space.canonicalOrigin === expected.canonicalOrigin);
        if (match.length !== 1) throw new Error("Credential fixture does not match the reviewed identity");
        return [key, lifecycleCredentialsSchema.parse({ username: match[0].username, password: match[0].password, rootPassword: match[0].rootPassword })];
      }));
      state = await prepareCloudLifecycle(configuration, z.object({ a: lifecycleCredentialsSchema, b: lifecycleCredentialsSchema }).parse(credentials), deps);
    } else {
      state = lifecycleStateSchema.parse(await json(statePath));
      if (lifecycleDigest(state.configuration) !== lifecycleDigest(configuration)) throw new Error("Scope changed after prepare");
      await runCloudLifecycle(state, action, values.approve ?? "", deps, values["inventory-sha256"]);
    }
    process.stdout.write(`${JSON.stringify(cloudLifecycleReport(state))}\n`);
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cloudLifecycleMain(); }
  catch (error) {
    // Error text from remote services or schema validators may contain credentials or user data.
    process.stderr.write(`Lifecycle acceptance stopped (${error instanceof GsvClientError ? `protocol ${error.code}` : "guard or request failure"}). Inspect private checkpoints; resume with the same state and operation IDs. No credentials were logged.\n`);
    process.exitCode = 1;
  }
}
