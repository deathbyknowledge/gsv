import { Bash } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../../../kernel/context";
import * as federation from "../../../kernel/federation";
import * as profiles from "../../../kernel/profiles";
import { testPeer } from "../../../test-support/peers";
import { buildContactCommand } from "./contact";

function shell(installationIdentity: KernelContext["installationIdentity"] = null, primaryDomain?: string) {
  const env = { GSV_PUBLIC_CONFIG: primaryDomain ? JSON.stringify({ primaryDomain }) : undefined };
  // SAFETY: handlers are mocked here; command parsing only reads the caller grant, installation address and public deployment config.
  const ctx = { installationIdentity, env, peer: testPeer({ account: { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" }, calls: ["contact.*", "profile.resolve"] }) } as KernelContext;
  return new Bash({ customCommands: [buildContactCommand(ctx)] });
}

afterEach(() => vi.restoreAllMocks());

describe("contact invitation handling", () => {
  it("passes each owner's explicit choice through create and accept", async () => {
    const create = vi.spyOn(federation, "handleContactInviteCreate").mockResolvedValue({ inviteId: "invite:test", code: "code", url: "https://example.com/connect#contact=code", expiresAtMs: 1 });
    const accept = vi.spyOn(federation, "handleContactInviteAccept").mockImplementation(async () => { throw new Error("reached acceptance"); });
    const bash = shell();
    expect((await bash.exec("contact invite create --handling ship --expires 7d")).exitCode).toBe(0);
    expect(create).toHaveBeenCalledWith({ shipHandlesMessages: true, expiresInSeconds: 604800 }, expect.anything());
    expect((await bash.exec("contact invite accept 'https://example.com/connect#contact=code' --handling manual")).stderr).toContain("reached acceptance");
    expect(accept).toHaveBeenCalledWith({ code: "https://example.com/connect#contact=code", shipHandlesMessages: false }, expect.anything());
  });

  it("makes no invitation mutation when the handling choice is missing or invalid", async () => {
    const create = vi.spyOn(federation, "handleContactInviteCreate");
    const accept = vi.spyOn(federation, "handleContactInviteAccept");
    const bash = shell();
    for (const command of ["contact invite create", "contact invite accept code", "contact invite create --handling auto", "contact invite create --handling manual --handling ship"]) {
      expect((await bash.exec(command)).exitCode).toBe(1);
    }
    expect(create).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("contact find", () => {
  const esteve = { installationId: "inst_test", handle: "esteve", canonicalOrigin: "https://esteve.ship.space" };

  it("reads a handle on this Ship's domain and a full address elsewhere", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve").mockImplementation(async () => { throw new Error("reached resolve"); });
    const bash = shell(esteve);
    for (const [input, url] of [
      ["@ada", "https://ada.ship.space/profile"],
      ["Ada", "https://ada.ship.space/profile"],
      ["ada.example.com", "https://ada.example.com"],
      ["https://ada.example.com/profile", "https://ada.example.com/profile"],
    ]) {
      expect((await bash.exec(`contact find ${input}`)).stderr).toContain("reached resolve");
      expect(resolve).toHaveBeenLastCalledWith({ url }, expect.anything());
    }
  });

  it("asks for a full address when this Ship has no handle domain", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve");
    const result = await shell().exec("contact find @ada");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("full address");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reads handles on the operator's primary domain from a Ship on a legacy domain", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve").mockImplementation(async () => { throw new Error("reached resolve"); });
    await shell({ ...esteve, canonicalOrigin: "https://esteve.gsv.space" }, "ship.space").exec("contact find @ada");
    expect(resolve).toHaveBeenLastCalledWith({ url: "https://ada.ship.space/profile" }, expect.anything());
  });
});
