import { describe, expect, it, vi } from "vitest";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { handleOwnerLink } from "./owner";
import { sha256 } from "../account-recovery";

function fixture(uid = 0) {
  const peer = testPeer({ account: { uid, gid: uid, gids: [uid], username: uid === 0 ? "root" : "person", home: "/root", cwd: "/root" }, calls: ["*"] });
  const begin = vi.fn(async () => ({ url: "https://accounts.example.com/owner/link", expiresAt: Date.now() + 300_000 }));
  const record = vi.fn();
  // SAFETY: the handler reads only the peer, immutable identity, credential epoch and owned services below.
  const ctx = { peer, installationId: "inst_this_space", installationIdentity: { installationId: "inst_this_space", canonicalOrigin: "https://space.example.com" },
    env: { INSTALLATION_OWNERSHIP: { beginInstallationOwnerLink: begin } }, auth: { credentialEpoch: () => 4 }, accountRecovery: { beginOwnerLink: record } } as KernelContext;
  return { ctx, begin, record };
}

describe("root owner linking syscall", () => {
  it("attests only the Kernel's installation and sends a hash to Accounts", async () => {
    const f = fixture();
    const args = { id: crypto.randomUUID(), secret: crypto.randomUUID() + crypto.randomUUID() };
    const result = await handleOwnerLink(args, f.ctx);
    const hash = await sha256(args.secret);
    expect(f.record).toHaveBeenCalledWith(args.id, hash, 4);
    expect(f.begin).toHaveBeenCalledWith({ installationId: "inst_this_space", attemptId: args.id, secretHash: hash });
    expect(new URLSearchParams(new URL(result.url).hash.slice(1)).get("secret")).toBe(args.secret);
  });

  it("rejects ordinary people and a Process running as root despite its human-shaped principal", async () => {
    const person = fixture(1000);
    const process = fixture();
    process.ctx.peer!.provenance = { kind: "process-registry", processId: "proc:root-agent" };
    for (const f of [person, process]) {
      await expect(handleOwnerLink({ id: crypto.randomUUID(), secret: "s".repeat(43) }, f.ctx)).rejects.toThrow("signed-in root human");
      expect(f.begin).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
    }
  });
});
