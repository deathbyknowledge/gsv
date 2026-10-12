import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Bash } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { makeShadowEntry } from "../../../auth/shadow";
import type { Kernel } from "../../../kernel/do";
import type { KernelContext } from "../../../kernel/context";
import { handleAdapterPairConfirm, handleAdapterPairDisconnect } from "../../../kernel/adapter-pairing";
import { canLinkAdapter } from "../../../kernel/adapter-pairing-policy";
import { testPeer } from "../../../test-support/peers";
import * as utils from "../../../shared/utils";
import { buildMessengerCommand } from "./messenger";

const CODE = "ABCD-EFGH-JKLM";
const candidate = { accountId: "managed", actorId: "external-person", surfaceId: "private-chat", expiresAt: Date.now() + 60_000, linked: false };
const calls = ["adapter.list", "adapter.pair.info", "adapter.pair.inspect", "adapter.pair.confirm"];

function pairingService(ctx: KernelContext, adapter: string) {
  const prepared = { candidate, route: { installationId: ctx.installationId, localUid: 1000, generation: "generation-1" } };
  return {
    adapterDescribe: vi.fn(async () => ({ version: 1, id: adapter, displayName: adapter, capabilities: {
      connect: false, disconnect: false, send: true, status: true, activity: true, pairing: true,
      surfaces: ["dm"], media: { inbound: [], outbound: [] },
    } })),
    adapterPairingInfo: vi.fn(async () => ({ accountId: "managed", configured: true, installUrl: "https://messenger.example/bot", instructions: "Send link to the bot to get a code." })),
    adapterPairingInspect: vi.fn(async () => candidate),
    adapterPairingPrepare: vi.fn(async () => prepared),
    adapterPairingActivate: vi.fn(async () => prepared),
    adapterPairingFinalize: vi.fn(async () => prepared),
    adapterPairingDisconnect: vi.fn(async () => ({ disconnected: true })),
  };
}

async function fixture(adapter: string, work: (ctx: KernelContext, shell: Bash, service: ReturnType<typeof pairingService>) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    await kernel.auth.bootstrap();
    for (const [uid, username] of [[1000, "owner"], [1001, "ship"], [1002, "crew"]] as const) {
      kernel.auth.addUser({ uid, gid: uid, username, home: `/home/${username}`, gecos: "", shell: "/bin/sh" });
      kernel.auth.setShadow(makeShadowEntry(username, uid === 1000 ? "test-password-hash" : "!"));
    }
    const account = { uid: 1001, gid: 1001, gids: [1001], username: "ship", home: "/home/ship", cwd: "/home/ship" };
    kernel.procs.spawn("ship", account, { ownerUid: 1000 });
    for (const call of calls) kernel.caps.grant(1001, call);
    const ctx = kernel.buildProcessContext("ship")!;
    ctx.installationIdentity = { installationId: ctx.installationId, handle: "test", canonicalOrigin: "https://test.gsv.space" };
    const service = pairingService(ctx, adapter);
    ctx.env = { ...ctx.env, [`CHANNEL_${adapter.toUpperCase()}`]: service };
    const shell = new Bash({ customCommands: [buildMessengerCommand(ctx)], files: { "/tmp/code.txt": CODE } });
    await work(ctx, shell, service);
  });
}

describe("messenger pairing from the native shell", () => {
  it.each(["whatsapp", "telegram", "slack", "discord"])("discovers and connects %s for the human owner", async (adapter) => {
    await fixture(adapter, async (ctx, shell, service) => {
      ctx.callerOwnerUid = 1002;
      const list = await shell.exec("messenger list");
      expect(list.exitCode, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout).adapters).toContainEqual(expect.objectContaining({ adapter, canLink: true, enabled: true }));
      const setup = await shell.exec(`messenger setup ${adapter}`);
      expect(setup.exitCode, setup.stderr).toBe(0);
      expect(JSON.parse(setup.stdout)).toMatchObject({ adapter, instructions: "Send link to the bot to get a code.", installUrl: "https://messenger.example/bot" });
      expect((await shell.exec(`messenger inspect ${adapter} < /tmp/code.txt`)).exitCode).toBe(0);
      expect(service.adapterPairingPrepare).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await shell.exec(`messenger connect ${adapter} < /tmp/code.txt`);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ paired: true, adapter, uid: 1000 });
      }
      expect(ctx.adapters.identityLinks.get(adapter, candidate.accountId, candidate.actorId)).toMatchObject({ uid: 1000, linkedByUid: 1001, metadata: { humanConfirmed: false } });
      expect(service.adapterPairingPrepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ installationId: ctx.installationId, localUid: 1000, code: "ABCDEFGHJKLM" }));
      await expect(handleAdapterPairDisconnect({ adapter, accountId: candidate.accountId, actorId: candidate.actorId }, ctx)).rejects.toThrow("direct signed-in");
    });
  });

  it("checks capabilities and rejects untrusted process provenance, machine and service callers", async () => {
    await fixture("whatsapp", async (ctx, shell, service) => {
      const peer = ctx.peer!;
      peer.peer.grant.calls = ["adapter.list", "adapter.pair.confirm"];
      expect(canLinkAdapter(ctx)).toBe(false);
      expect((await shell.exec("messenger connect whatsapp < /tmp/code.txt")).stderr).toContain("cannot complete");
      peer.peer.grant.calls = [];
      for (const command of ["list", "setup whatsapp", "inspect whatsapp < /tmp/code.txt", "connect whatsapp < /tmp/code.txt"]) {
        expect((await shell.exec(`messenger ${command}`)).stderr).toContain("Permission denied");
      }
      for (const kind of ["human", "machine", "service"] as const) {
        ctx.peer = testPeer({ account: peer.peer.principal.account, kind, calls: ["*"] });
        await expect(handleAdapterPairConfirm({ adapter: "whatsapp", code: CODE }, ctx)).rejects.toThrow("direct signed-in");
      }
      ctx.peer = peer;
      ctx.peer.peer.grant.calls = calls;
      ctx.processId = "missing";
      ctx.peer.provenance = { kind: "process-registry", processId: "missing" };
      expect(canLinkAdapter(ctx)).toBe(false);
      expect(service.adapterPairingPrepare).not.toHaveBeenCalled();
    });
  });

  it("rejects an inactive owner and a code linked to another account", async () => {
    await fixture("telegram", async (ctx, shell, service) => {
      ctx.adapters.identityLinks.link("telegram", candidate.accountId, candidate.actorId, 1002, 1002);
      expect((await shell.exec("messenger connect telegram < /tmp/code.txt")).stderr).toContain("another user");
      ctx.auth.setShadow(makeShadowEntry("owner", "!"));
      expect(canLinkAdapter(ctx)).toBe(false);
      expect((await shell.exec("messenger connect telegram < /tmp/code.txt")).stderr).toContain("active human account");
      expect(service.adapterPairingPrepare).not.toHaveBeenCalled();
    });
  });

  it("honors tool policy without requiring an extra confirmation or exposing the code", async () => {
    await fixture("whatsapp", async (ctx, shell, service) => {
      ctx.toolOwner = { runId: "run", requestId: "tool" };
      const authorize = vi.spyOn(utils, "sendFrameToProcess").mockResolvedValue({ type: "res", id: "denied", ok: false, error: { code: 403, message: "Pairing denied by policy" } });
      try {
        expect((await shell.exec("messenger connect whatsapp < /tmp/code.txt")).stderr).toContain("Pairing denied by policy");
        expect(service.adapterPairingPrepare).not.toHaveBeenCalled();
        const authorization = JSON.stringify(authorize.mock.calls);
        expect(authorization).toContain("adapter.pair.confirm");
        expect(authorization).not.toContain(CODE);
        expect(authorization).not.toContain('"defaultAction":"ask"');
        authorize.mockResolvedValue({ type: "res", id: "approved", ok: true, data: { approved: true } });
        const result = await shell.exec("messenger connect whatsapp < /tmp/code.txt");
        expect(result.exitCode, result.stderr).toBe(0);
      } finally { authorize.mockRestore(); }
    });
  });

  it("stops cancelled work before preparation or local linking", async () => {
    await fixture("whatsapp", async (ctx, shell, service) => {
      let abort = new AbortController();
      ctx.requestSignal = abort.signal;
      abort.abort();
      expect((await shell.exec("messenger connect whatsapp < /tmp/code.txt")).exitCode).toBe(1);
      expect(service.adapterPairingPrepare).not.toHaveBeenCalled();
      abort = new AbortController();
      ctx.requestSignal = abort.signal;
      const prepare = service.adapterPairingPrepare.getMockImplementation()!;
      service.adapterPairingPrepare.mockImplementation(async () => { abort.abort(); return prepare(); });
      expect((await shell.exec("messenger connect whatsapp < /tmp/code.txt")).exitCode).toBe(1);
      expect(service.adapterPairingActivate).not.toHaveBeenCalled();
      expect(ctx.adapters.identityLinks.get("whatsapp", candidate.accountId, candidate.actorId)).toBeNull();
    });
  });

  it("reports expired codes and unavailable messengers without claiming a connection", async () => {
    await fixture("whatsapp", async (ctx, shell, service) => {
      service.adapterPairingInspect.mockRejectedValue(new Error("Pairing code expired"));
      service.adapterPairingPrepare.mockRejectedValue(new Error("Pairing code expired"));
      expect(await shell.exec("messenger connect whatsapp < /tmp/code.txt")).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("expired") });
      service.adapterPairingInfo.mockResolvedValue({ accountId: "managed", configured: false, installUrl: "https://messenger.example/bot", instructions: "Unavailable" });
      expect((await shell.exec("messenger connect whatsapp < /tmp/code.txt")).stderr).toContain("not enabled");
      expect(service.adapterPairingActivate).not.toHaveBeenCalled();
    });
  });

  it.each(["human", "legacy-human", "process", "revoked-human"])("preserves only an active %s confirmation when reconnecting", async (previous) => {
    await fixture("whatsapp", async (ctx, shell) => {
      const metadata = {
        managed: true, surfaceKind: "dm", surfaceId: candidate.surfaceId, routeGeneration: "previous-generation", operationId: "previous-operation",
        humanConfirmed: previous === "legacy-human" ? undefined : previous !== "process",
      };
      ctx.adapters.identityLinks.link("whatsapp", candidate.accountId, candidate.actorId, 1000, 1000, metadata);
      if (previous === "revoked-human") ctx.auth.replaceHumanPassword(1000, "new-test-password-hash", "password reset");
      const result = await shell.exec("messenger connect whatsapp < /tmp/code.txt");
      expect(result.exitCode, result.stderr).toBe(0);
      const retained = previous === "human" || previous === "legacy-human";
      expect(ctx.adapters.identityLinks.get("whatsapp", candidate.accountId, candidate.actorId)).toMatchObject({
        linkedByUid: retained ? 1000 : 1001, metadata: { humanConfirmed: retained, routeGeneration: "generation-1" },
      });
    });
  });

  it.each(["adapterPairingActivate", "adapterPairingFinalize"] as const)("owns completion when cancelled during %s", async (phase) => {
    await fixture("whatsapp", async (ctx, shell, service) => {
      const abort = new AbortController();
      ctx.requestSignal = abort.signal;
      const operation = service[phase].getMockImplementation()!;
      service[phase].mockImplementation(async () => { abort.abort(); return operation(); });
      const deferred = vi.spyOn(ctx, "defer");
      const result = await shell.exec("messenger connect whatsapp < /tmp/code.txt");
      expect(result.exitCode, result.stderr).toBe(0);
      expect(deferred).toHaveBeenCalledWith(expect.any(Promise));
      expect(service.adapterPairingFinalize).toHaveBeenCalledOnce();
      expect(ctx.adapters.identityLinks.get("whatsapp", candidate.accountId, candidate.actorId)?.uid).toBe(1000);
      expect(ctx.adapters.status.get("whatsapp", candidate.accountId)).toMatchObject({ connected: true, authenticated: true });
    });
  });
});
