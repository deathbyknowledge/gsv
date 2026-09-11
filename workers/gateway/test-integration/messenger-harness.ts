import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness, unstable_readConfig, type Unstable_RawConfig } from "wrangler";
import { integrationDependencyConfig, integrationExecutionConfig, integrationGatewayConfig } from "./harness";
import { discordProviderFixture } from "../../adapters/discord/test/fixtures";
import { slackApiWorkerScript } from "../../adapters/slack/test/fixture-workers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const messengerGateway = "gsv-messenger-kernel-test";
export const messengerGate = "gsv-messenger-wire-test";
export const messengers = ["telegram", "slack", "discord"] as const;
export type Messenger = typeof messengers[number];
export const adapterWorkers = { telegram: "gsv-managed-telegram-test", slack: "gsv-managed-slack-test", discord: "gsv-shared-discord-test" };
export const providerWorkers = { telegram: "managed-telegram-api-test", slack: "managed-slack-api-test", discord: "shared-discord-api-test" };
const channelEntrypoints = { telegram: "ManagedTelegramChannel", slack: "ManagedSlackChannel", discord: "SharedDiscordChannel" };

const telegramFixture = `
let nextId = 100;
const messages = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/messages") return Response.json(messages);
    const method = url.pathname.split("/").at(-1);
    const body = await request.json();
    if (["sendMessage", "sendRichMessage"].includes(method)) {
      const result = { message_id: nextId++ };
      messages.push({ method, body: { ...body, text: body.text ?? body.rich_message?.markdown ?? "" }, result });
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: true, result: true });
  }
};`;

/** Faults surround actual provider fixtures; they never answer Kernel admission. */
function controlledProvider(script: string): string {
  return script.replace(/export default\s*\{/, "const fixture = {") + `
const failures = new Map();
const attempts = [];
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/outcome") {
      const input = await request.json(); failures.set(input.text, input.kind);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__test/attempts") return Response.json(attempts);
    if (request.method === "POST" && /sendMessage|sendRichMessage|chat.postMessage|channels\\/[0-9]+\\/messages$/.test(url.pathname)) {
      const body = await request.clone().json();
      const text = body.text ?? body.content ?? body.rich_message?.markdown ?? "";
      attempts.push({ text, destination: body.chat_id ?? body.channel ?? url.pathname, nonce: body.nonce ?? body.client_msg_id });
      const failure = failures.get(text); failures.delete(text);
      if (failure === "retryable") return Response.json({ ok: false, error: "ratelimited", error_code: 429, retry_after: 0, parameters: { retry_after: 0 } }, { status: 429, headers: { "retry-after": "0" } });
      const response = await fixture.fetch(request, env, ctx);
      if (failure === "ambiguous") return new Response("lost provider response", { status: 200 });
      return response;
    }
    return await fixture.fetch(request, env, ctx);
  }
};`;
}

export function createMessengerHarness() {
  const temporary = mkdtempSync(join(tmpdir(), "gsv-messenger-contract-"));
  const gateway = integrationGatewayConfig({ name: messengerGateway, managed: true });
  gateway.services = [
    ...(gateway.services ?? []).filter((binding) => !binding.binding.startsWith("CHANNEL_")),
    ...messengers.map((id) => ({ binding: `CHANNEL_${id.toUpperCase()}`, service: messengerGate, entrypoint: "MessengerChannelGate", props: { id } })),
  ];
  const providers = messengers.map((id): Unstable_RawConfig => {
    const main = join(temporary, `${id}.mjs`);
    writeFileSync(main, controlledProvider(id === "discord" ? discordProviderFixture : id === "slack" ? slackApiWorkerScript("managed") : telegramFixture));
    const config: Unstable_RawConfig = { name: providerWorkers[id], main, compatibility_date: "2026-09-01" };
    if (id === "discord") {
      config.durable_objects = { bindings: [{ name: "PROVIDER", class_name: "Provider" }] };
      config.migrations = [{ tag: "v1", new_sqlite_classes: ["Provider"] }];
    }
    return config;
  });
  const adapters = messengers.map((id): Unstable_RawConfig => {
    const config = unstable_readConfig({ config: resolve(root, `../adapters/${id}/wrangler.${id === "discord" ? "shared" : "managed"}.test.jsonc`) }, { hideWarnings: true });
    const vars = { ...config.vars };
    if (id === "telegram") vars.TELEGRAM_ALLOWED_ACTOR_IDS = "";
    return {
      name: adapterWorkers[id], main: config.main, compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags, durable_objects: config.durable_objects, migrations: config.migrations,
      vars,
      services: (config.services ?? []).map((binding: NonNullable<Unstable_RawConfig["services"]>[number]) => binding.binding === "GATEWAY"
        ? { binding: "GATEWAY", service: messengerGate, entrypoint: "MessengerGatewayGate", props: { id } }
        : binding.binding === "ACCOUNTS" ? { binding: "ACCOUNTS", service: "gsv-test-dependencies" } : binding),
    };
  });
  const gate: Unstable_RawConfig = {
    name: messengerGate, main: resolve(root, "test-integration/fixtures/messenger-gate.ts"),
    compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "STATE", class_name: "MessengerGateState" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["MessengerGateState"] }],
    services: messengers.flatMap((id) => [
      { binding: `${id.toUpperCase()}_GATEWAY`, service: messengerGateway, entrypoint: "AdapterGatewayEntrypoint", props: { id, calls: ["adapter.inbound", "adapter.state.update"] } },
      { binding: `CHANNEL_${id.toUpperCase()}`, service: adapterWorkers[id], entrypoint: channelEntrypoints[id] },
    ]),
  };
  const harness = createTestHarness({ root, workers: [gateway, integrationDependencyConfig(messengerGateway), integrationExecutionConfig(), gate, ...adapters, ...providers].map((config) => ({ config })) });
  return { harness, removeFixtures: () => rmSync(temporary, { recursive: true, force: true }) };
}
