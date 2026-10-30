/**
 * Fresh-onboarding bench: boots the real gateway under workerd with the real
 * ripgit worker, runs setup with a chosen language, dismisses the welcome card,
 * and records the Ship's first turn against the production model through a
 * recording proxy. See README.md.
 *
 *   npx tsx bench/onboarding/run.ts --label baseline --langs en,es,de --runs 7
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GSVClient } from "@humansandmachines/gsv";
import { createTestHarness, type TestHarness } from "wrangler";
import {
  integrationDependencyConfig,
  integrationExecutionConfig,
  integrationGatewayConfig,
} from "../../workers/gateway/test-integration/harness";
import { readTogetherKey, startProxy, type ModelStep, type RecordingProxy, type RipgitCall } from "./proxy";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const GATEWAY_ROOT = resolve(REPO, "workers/gateway");
const PASSWORD = "onboarding-bench-password";
const PROD_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const COST_CAP_USD = 20;

const { values: flags } = parseArgs({
  options: {
    label: { type: "string", default: "baseline" },
    langs: { type: "string", default: "en,es,de" },
    runs: { type: "string", default: "1" },
    timeout: { type: "string", default: "300000" },
    settle: { type: "string", default: "4000" },
    reasoning: { type: "string" },
    reply: { type: "string" },
    "dump-requests": { type: "boolean", default: false },
    "ripgit-latency": { type: "string", default: "0" },
    keep: { type: "boolean", default: false },
  },
});

const OUT = resolve(HERE, "runs", flags.label);
const SPEND_FILE = resolve(HERE, "runs", "spend.jsonl");

const AUTO_REPLY: Record<string, string> = {
  en: "I'm Bob, I work in finance in LA.",
  es: "Soy Rosa, estudio estadística y vivo en Sevilla.",
  de: "Ich bin Jonas, ich arbeite in der Buchhaltung in Hamburg.",
  fr: "Je suis Claire, je suis comptable à Lyon.",
  ja: "ボブです。大阪で経理の仕事をしています。",
};

async function totalSpend(): Promise<number> {
  try {
    const lines = (await readFile(SPEND_FILE, "utf8")).split("\n").filter(Boolean);
    return lines.reduce((sum, line) => sum + (JSON.parse(line) as { costUsd: number }).costUsd, 0);
  } catch {
    return 0;
  }
}

function bootHarness(proxy: RecordingProxy): TestHarness {
  const gateway = integrationGatewayConfig({ workersAi: true });
  gateway.services = (gateway.services ?? []).map((binding) => binding.binding === "RIPGIT"
    ? { binding: "RIPGIT", service: "bench-ripgit-probe" }
    : binding);
  const execution = integrationExecutionConfig(true);
  execution.services = (execution.services ?? []).map((binding) => binding.binding === "FUNDED_INFERENCE"
    ? { binding: "FUNDED_INFERENCE", service: "bench-funded-inference" }
    : binding);
  return createTestHarness({
    root: GATEWAY_ROOT,
    workers: [
      { config: gateway },
      { config: integrationDependencyConfig("gsv") },
      { config: execution },
      {
        config: {
          name: "ripgit",
          main: resolve(REPO, "workers/ripgit/build/index.js"),
          compatibility_date: "2026-03-18",
          kv_namespaces: [{ binding: "REGISTRY", id: "bench-registry" }],
          durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
        },
      },
      {
        config: {
          name: "bench-ripgit-probe",
          main: resolve(HERE, "ripgit-probe.ts"),
          compatibility_date: "2026-09-01",
          compatibility_flags: ["nodejs_compat"],
          vars: { LOG_URL: proxy.ripgitLogUrl, RIPGIT_LATENCY_MS: flags["ripgit-latency"] },
          services: [{ binding: "REAL", service: "ripgit" }],
        },
      },
      {
        config: {
          name: "bench-funded-inference",
          main: resolve(HERE, "funded-inference.ts"),
          compatibility_date: "2026-09-01",
          compatibility_flags: ["nodejs_compat", "enable_nodejs_os_module"],
          vars: { PROXY_BASE_URL: proxy.baseUrl, MODEL_ID: PROD_MODEL, DISPLAY_NAME: "DeepSeek V4.1 Flash" },
        },
      },
    ],
  });
}

type RunResult = {
  label: string;
  lang: string;
  run: number;
  ok: boolean;
  error: string | null;
  setupMs: number;
  dismissToFirstRequestMs: number | null;
  dismissToRunEndMs: number | null;
  dismissToFirstMessageMs: number | null;
  firstMessage: string | null;
  messages: string[];
  responsibilityState: string | null;
  steps: ModelStep[];
  ledger: Array<{ seq: number; timestamp: number; call: string; args: string; outcome: unknown; durationMs: number | null; target: string; pid: string | null; runId: string | null }>;
  records: unknown[];
  trace: unknown[];
  ripgit: RipgitCall[];
  reply: { steps: ModelStep[]; firstMessageMs: number | null; endMs: number | null; messages: string[]; state: string | null } | null;
  dismissedAt: number;
  costUsd: number;
};

async function oneRun(proxy: RecordingProxy, lang: string, run: number): Promise<RunResult> {
  const timeoutMs = Number(flags.timeout);
  proxy.take();
  proxy.takeRipgit();
  const harness = bootHarness(proxy);
  const clients: GSVClient[] = [];
  const result: RunResult = {
    label: flags.label, lang, run, ok: false, error: null, setupMs: 0,
    dismissToFirstRequestMs: null, dismissToRunEndMs: null, dismissToFirstMessageMs: null,
    firstMessage: null, messages: [], responsibilityState: null, steps: [], ledger: [], records: [], trace: [], ripgit: [], reply: null, dismissedAt: 0, costUsd: 0,
  };
  try {
    const { url } = await harness.listen();
    const endpoint = new URL(url);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    endpoint.pathname = "/ws";
    const wsUrl = endpoint.toString();

    const username = "rosa";
    const setupStart = Date.now();
    await new GSVClient().requestOnce(wsUrl, "sys.setup", {
      onboardingToken: "integration-onboarding-default",
      username,
      password: PASSWORD,
      language: lang,
      timezone: lang === "es" ? "Europe/Madrid" : lang === "de" ? "Europe/Berlin" : lang === "ja" ? "Asia/Tokyo" : "America/New_York",
    });
    result.setupMs = Date.now() - setupStart;

    const client = new GSVClient({
      url: wsUrl, username, password: PASSWORD,
      peer: { id: "onboarding-bench", platform: "browser", version: "bench" },
    });
    clients.push(client);
    await client.connect();
    const { conversation } = await client.conversation.ship({});

    if (flags.reasoning) {
      const listed = await client.proc.list({});
      const ship = listed.processes.find((process) => process.personal);
      if (ship) await client.proc.ai.config.set({ pid: ship.pid, reasoning: flags.reasoning });
    }

    const dismissedAt = Date.now();
    result.dismissedAt = dismissedAt;
    await client.sys.config.set({ key: "users/1000/ui/welcome_card_seen", value: "1" });

    const deadline = dismissedAt + timeoutMs;
    let firstMessageAt: number | null = null;
    let finishedAt: number | null = null;
    let quietSince: number | null = null;
    let sawWork = false;
    let lastStepCount = 0;
    while (Date.now() < deadline) {
      const history = await client.conversation.history({ conversationId: conversation.id });
      if (history.messages.length > 0 && firstMessageAt === null) firstMessageAt = Date.now();
      const listed = await client.proc.list({});
      const busy = listed.processes.some((process) => (process.activeRunId ?? null) !== null || (process.queuedCount ?? 0) > 0);
      const stepCount = result.steps.length;
      if (busy) sawWork = true;
      if (busy || !sawWork) {
        quietSince = null;
        finishedAt = null;
      } else {
        quietSince ??= Date.now();
        finishedAt ??= Date.now();
        if (Date.now() - quietSince >= Number(flags.settle)) break;
      }
      lastStepCount = stepCount;
      await new Promise((done) => setTimeout(done, 100));
    }
    void lastStepCount;

    result.steps = proxy.take();
    result.costUsd = result.steps.reduce((sum, step) => sum + step.costUsd, 0);
    const first = result.steps[0];
    if (first) result.dismissToFirstRequestMs = first.startedAt - dismissedAt;
    if (firstMessageAt) result.dismissToFirstMessageMs = firstMessageAt - dismissedAt;
    if (finishedAt) result.dismissToRunEndMs = finishedAt - dismissedAt;

    const history = await client.conversation.history({ conversationId: conversation.id });
    result.messages = history.messages.map((message) => message.text ?? "");
    result.firstMessage = result.messages[0] ?? null;
    const { responsibilities } = await client.r12y.list({ includeTerminal: true });
    result.responsibilityState = responsibilities.find((record) => record.details?.responsibilityType === "onboarding.initial")?.state ?? null;

    const lines: RunResult["ledger"] = [];
    let cursor: string | undefined;
    for (;;) {
      const listed = await client.sys.ledger.list(cursor ? { limit: 200, cursor } : { limit: 200 });
      lines.push(...listed.lines.map((line) => ({
        seq: line.seq, timestamp: line.timestamp, call: line.call, args: line.args, outcome: line.outcome,
        durationMs: line.durationMs, target: line.target, pid: line.pid, runId: line.runId,
      })));
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
    result.ledger = lines;
    const listed = await client.proc.list({});
    const ship = listed.processes.find((process) => process.personal);
    if (ship) {
      const procHistory = await client.proc.history({ pid: ship.pid, format: 2, tail: true, limit: 500 });
      result.records = "records" in procHistory && Array.isArray(procHistory.records) ? procHistory.records : [];
      const trace = await client.proc.trace({ pid: ship.pid, limit: 500 });
      result.trace = trace.ok ? trace.spans : [];
    }
    result.ripgit = proxy.takeRipgit();
    result.ok = finishedAt !== null && result.steps.length > 0;

    if (flags.reply) {
      const before = result.messages.length;
      const sentAt = Date.now();
      const replyText = flags.reply === "auto" ? AUTO_REPLY[lang] ?? AUTO_REPLY.en : flags.reply;
      await client.conversation.send({ conversationId: conversation.id, text: replyText, idempotencyKey: `bench-reply-${sentAt}` });
      let replyAt: number | null = null;
      let endAt: number | null = null;
      let quiet: number | null = null;
      let seen = false;
      while (Date.now() < sentAt + timeoutMs) {
        const now = await client.conversation.history({ conversationId: conversation.id });
        const replies = now.messages.filter((message) => message.author.kind !== "user");
        if (replies.length > before && replyAt === null) replyAt = Date.now();
        const processes = await client.proc.list({});
        const active = processes.processes.some((process) => (process.activeRunId ?? null) !== null || (process.queuedCount ?? 0) > 0);
        if (active) seen = true;
        if (active || !seen) {
          quiet = null;
          endAt = null;
        } else {
          quiet ??= Date.now();
          endAt ??= Date.now();
          if (Date.now() - quiet >= Number(flags.settle)) break;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      const steps = proxy.take();
      const final = await client.conversation.history({ conversationId: conversation.id });
      const after = await client.r12y.list({ includeTerminal: true });
      result.reply = {
        steps,
        firstMessageMs: replyAt === null ? null : replyAt - sentAt,
        endMs: endAt === null ? null : endAt - sentAt,
        messages: final.messages.map((message) => message.text ?? ""),
        state: after.responsibilities.find((record) => record.details?.responsibilityType === "onboarding.initial")?.state ?? null,
      };
      result.costUsd += steps.reduce((sum, step) => sum + step.costUsd, 0);
    }
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    result.steps = result.steps.length ? result.steps : proxy.take();
    result.costUsd = result.steps.reduce((sum, step) => sum + step.costUsd, 0);
  } finally {
    for (const client of clients) client.close();
    await harness.close().catch(() => undefined);
  }
  return result;
}

const proxy = await startProxy({ apiKey: readTogetherKey() });
await mkdir(OUT, { recursive: true });
const langs = flags.langs.split(",").map((value) => value.trim()).filter(Boolean);
const runs = Number(flags.runs);
try {
  for (let run = 0; run < runs; run++) {
    for (const lang of langs) {
      const spent = await totalSpend();
      if (spent >= COST_CAP_USD) {
        console.error(`stopping: spend $${spent.toFixed(4)} reached the $${COST_CAP_USD} cap`);
        process.exit(3);
      }
      const startedAt = Date.now();
      const result = await oneRun(proxy, lang, run);
      await writeFile(resolve(OUT, `${lang}-${run}-${startedAt}.json`), JSON.stringify(result, null, 1));
      if (flags["dump-requests"]) await writeFile(resolve(OUT, `${lang}-${run}-${startedAt}.requests`), JSON.stringify(proxy.requests.splice(0), null, 1));
      await appendFile(SPEND_FILE, `${JSON.stringify({ label: flags.label, lang, run, at: startedAt, costUsd: result.costUsd })}\n`);
      const calls = result.steps.flatMap((step) => step.toolCalls.map((call) => call.name)).join(",");
      console.log(`[${flags.label}] ${lang}#${run} ok=${result.ok} steps=${result.steps.length} setup=${result.setupMs}ms toFirstReq=${result.dismissToFirstRequestMs} toFirstMsg=${result.dismissToFirstMessageMs} toEnd=${result.dismissToRunEndMs} $${result.costUsd.toFixed(4)} total$${(await totalSpend()).toFixed(4)} state=${result.responsibilityState} calls=[${calls}]${result.error ? ` ERROR ${result.error}` : ""}`);
    }
  }
} finally {
  await proxy.close();
}
process.exit(0);
