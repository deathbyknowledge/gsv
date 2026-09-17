import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedTelegramPeerEnv } from "../src/managed-peer";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedTelegramPeerEnv & { TELEGRAM_API: Fetcher };
type TelegramApiMessage = { body: { text?: string } };
type GatewayCall = { call?: string; args?: { message?: { text?: string } } };

function update(updateId: number, text: string): Request {
  return new Request("https://telegram.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test_webhook_secret_123",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1_700_000_000 + updateId,
        text,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Hank", username: "hank_test" },
      },
    }),
  });
}

async function telegramMessages(): Promise<TelegramApiMessage[]> {
  return await (await bindings.TELEGRAM_API.fetch("https://telegram-api.test/messages")).json();
}

// Recovery replaces the route; keep it in its own per-file storage environment.
it("offers fresh pairing after password revocation and waits for confirmation before replacing the route", async () => {
  const peer = bindings.MANAGED_TELEGRAM_PEER.getByName("managed:12345");
  const previousRoute = {
    installationId: "installation_recovery", localUid: 1000, generation: "revoked-generation",
    canonicalOrigin: "https://recovery.gsv.test", linkedAt: Date.now(),
  };
  await runInDurableObject(peer, async (_instance, state) => {
    await state.storage.put("managed_telegram_peer:v1:state", {
      version: 1, actorId: "12345", surfaceId: "12345", activeRoute: previousRoute,
    });
  });
  const before = (await telegramMessages()).length;
  expect((await SELF.fetch(update(501, "__identity_revoked__"))).status).toBe(200);
  let code = "";
  await vi.waitFor(async () => {
    const text = (await telegramMessages()).slice(before).find((message) => message.body.text?.includes("Pairing code:"))?.body.text ?? "";
    code = text.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0]?.replaceAll("-", "") ?? "";
    expect(code).toHaveLength(12);
  });
  await runInDurableObject(peer, async (_instance, state) => {
    expect(await state.storage.get("managed_telegram_peer:v1:state")).toMatchObject({ activeRoute: previousRoute });
  });
  const pairing = bindings.MANAGED_TELEGRAM_PAIRING.getByName(`pair:${code}`);
  using candidate = await pairing.inspect();
  expect(candidate).toMatchObject({ actorId: "12345", linked: true });
  const operation = {
    code, installationId: previousRoute.installationId, localUid: 1000,
    operationId: "confirm-after-recovery", canonicalOrigin: previousRoute.canonicalOrigin,
  };
  using prepared = await pairing.prepare(operation);
  expect(prepared.route.generation).not.toBe(previousRoute.generation);
  const activation = { code, operationId: operation.operationId, route: prepared.route, canonicalOrigin: operation.canonicalOrigin };
  using activated = await pairing.activate(activation);
  using finalized = await pairing.finalize(activation);
  expect(activated.route.generation).toBe(prepared.route.generation);
  expect(finalized.route.generation).toBe(prepared.route.generation);

  expect((await SELF.fetch(update(502, "hello after reconnecting"))).status).toBe(200);
  await vi.waitFor(async () => {
    expect(await telegramMessages()).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ text: "Personal received hello after reconnecting" }),
    }));
  });
  const response = await bindings.GATEWAY.fetch("https://gateway.test/calls");
  const calls = (await response.json<GatewayCall[]>()).filter((call) => call.call === "adapter.inbound");
  expect(calls.filter((call) => call.args?.message?.text === "__identity_revoked__")).toHaveLength(1);
  expect(calls).toContainEqual(expect.objectContaining({
    installation: { installationId: previousRoute.installationId },
    args: expect.objectContaining({
      routeGeneration: prepared.route.generation,
      message: expect.objectContaining({ text: "hello after reconnecting" }),
    }),
  }));
});
