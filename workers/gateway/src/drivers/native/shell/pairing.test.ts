import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Bash } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { createPairingCredential, decodeDevicePairingCode } from "@humansandmachines/gsv/protocol";
import type { Kernel } from "../../../kernel/do";
import type { KernelContext } from "../../../kernel/context";
import { testPeer } from "../../../test-support/peers";
import { handleSysPairCreate } from "../../../kernel/sys/pair";
import * as utils from "../../../shared/utils";
import { buildTargetsCommands } from "./targets";

async function fixture(work: (ctx: KernelContext, shell: Bash) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    await kernel.auth.bootstrap();
    for (const [uid, username] of [[1000, "owner"], [1001, "ship"], [1002, "other"]] as const) {
      kernel.auth.addUser({ uid, gid: uid, username, home: `/home/${username}`, gecos: "", shell: "/bin/sh" });
    }
    const account = { uid: 1001, gid: 1001, gids: [1001], username: "ship", home: "/home/ship", cwd: "/home/ship" };
    kernel.procs.spawn("ship", account, { ownerUid: 1000 });
    for (const call of ["sys.pair.create", "sys.pair.list", "sys.pair.cancel", "sys.target.get"]) kernel.caps.grant(1001, call);
    const ctx = kernel.buildProcessContext("ship")!;
    ctx.installationIdentity = { installationId: ctx.installationId, handle: "test", canonicalOrigin: "https://test.staging.gsv.space" };
    await work(ctx, new Bash({ customCommands: buildTargetsCommands(ctx) }));
  });
}

describe("native target pairing", () => {
  it.each(["mac", "linux", "windows", "browser"])("enrolls a %s for the process owner with the space's address", async (platform) => {
    await fixture(async (ctx, shell) => {
      const result = await shell.exec(`targets pair --name 'My computer' --platform ${platform}`);
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      const invite = decodeDevicePairingCode(platform === "browser" ? output.code : output.pairCommand.split(" ").at(-1));
      expect(invite).toMatchObject({ username: "owner", label: "My computer", targetId: "my-computer", gatewayUrl: "wss://test.staging.gsv.space/ws" });
      if (platform === "browser") {
        expect(output.extensionUrl).toBe("https://gsv.space/browser?release=dev");
        expect(output.instructions).toContain("chrome://extensions");
        expect(output.instructions).toContain("Extensions button");
        expect(output.pairCommand).toBeUndefined();
      } else {
        expect(output.installCommand).toContain(platform === "windows" ? "install.ps1" : "GSV_CHANNEL=dev bash");
        expect(output.pairCommand).toMatch(platform === "windows" ? /^gsv.exe pair / : /^gsv pair /);
      }
      expect(ctx.pairings.list(1001)).toEqual([]);
      expect(JSON.parse((await shell.exec("targets pair list")).stdout).pairings).toHaveLength(1);
      expect(ctx.auth.listTokens()).toHaveLength(0);
      const credential = createPairingCredential();
      await ctx.pairings.redeem({ id: invite.id, secret: invite.secret, credential });
      expect(await ctx.auth.authenticateToken("owner", credential, { kind: "machine", peerId: invite.targetId })).toMatchObject({ ok: true });
      expect(await ctx.auth.authenticateToken("ship", credential, { kind: "machine", peerId: invite.targetId })).toMatchObject({ ok: false });
      expect(JSON.parse((await shell.exec(`targets pair cancel ${invite.id}`)).stdout).pairing.state).toBe("paired");
      expect(ctx.auth.listTokens()[0].revokedAt).toBeNull();
    });
  });

  it("requires capabilities and rejects machine and service principals", async () => {
    await fixture(async (ctx) => {
      const account = ctx.peer!.peer.principal.account;
      ctx.peer = testPeer({ account });
      for (const input of ["targets pair --name laptop --platform mac", "targets pair list", "targets pair cancel missing"]) {
        expect(await new Bash({ customCommands: buildTargetsCommands(ctx) }).exec(input)).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Permission denied") });
      }
      for (const kind of ["machine", "service"] as const) {
        ctx.peer = testPeer({ account, kind, calls: ["*"] });
        await expect(handleSysPairCreate({ id: crypto.randomUUID(), secret: "a".repeat(64), label: "Laptop", targetId: "laptop" }, ctx)).rejects.toThrow("signed-in human");
      }
      expect(ctx.pairings.list(1000)).toEqual([]);
    });
  });

  it("honors nested denial and cancellation before issuing an invitation", async () => {
    await fixture(async (ctx, shell) => {
      ctx.toolOwner = { runId: "run", requestId: "tool" };
      const authorize = vi.spyOn(utils, "sendFrameToProcess").mockResolvedValue({ type: "res", id: "denied", ok: false, error: { code: 403, message: "Pairing denied by policy" } });
      try {
        const result = await shell.exec("targets pair --name Laptop --platform mac");
        expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Pairing denied by policy") });
        expect(JSON.stringify(authorize.mock.calls)).not.toContain("secret");
      } finally { authorize.mockRestore(); }
      delete ctx.toolOwner;
      const controller = new AbortController();
      ctx.requestSignal = controller.signal;
      controller.abort();
      expect((await shell.exec("targets pair --name Laptop --platform mac")).exitCode).toBe(1);
      expect(ctx.pairings.list(1000)).toEqual([]);
    });
  });

  it("requires explicit replacement and can cancel a lost invitation without crossing owners", async () => {
    await fixture(async (ctx, shell) => {
      ctx.targets.register("laptop", 1000, 1000, ["shell.exec"], "macos", "test");
      expect((await shell.exec("targets pair --name Laptop --platform mac")).stderr).toContain("already in use");
      const created = await shell.exec("targets pair --name Laptop --platform mac --id laptop --replace");
      expect(created.exitCode, created.stderr).toBe(0);
      const { pairing } = JSON.parse(created.stdout);
      expect(ctx.pairings.list(1002)).toEqual([]);
      expect(() => ctx.pairings.cancel(1002, pairing.id)).toThrow("not found");
      expect(JSON.parse((await shell.exec(`targets pair cancel ${pairing.id}`)).stdout).pairing.state).toBe("cancelled");
      ctx.targets.register("other-laptop", 1002, 1002, ["shell.exec"], "macos", "test");
      expect((await shell.exec("targets pair --name Laptop --platform mac --id other-laptop --replace")).stderr).toContain("owned existing");
      for (const options of ["--platform solaris", "--platform mac --id 'bad/id'", "--platform mac --replace"]) {
        expect((await shell.exec(`targets pair --name Laptop ${options}`)).exitCode).toBe(1);
      }
      ctx.installationIdentity = null;
      expect((await shell.exec("targets pair --name New --platform mac")).stderr).toContain("Space address is unavailable");
      expect(ctx.pairings.list(1000)).toHaveLength(1);
    });
  });
});
