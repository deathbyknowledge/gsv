import { Bash } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import type { CloudInstance } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import { testPeer } from "../../../test-support/peers";
import type { NativeShellCommandOptions } from "./commands";
import { buildInstanceCommands } from "./instances";

const instance: CloudInstance = {
  instanceId: "12345678-full-id", targetId: "12345678", startRequestId: "saved", ownerUid: 1000,
  templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser",
  state: "starting", revision: 1, createdAt: 1, expiresAt: 9999999999999,
};
function fixture(request: NonNullable<NativeShellCommandOptions["request"]>, calls = ["*"]) {
  // SAFETY: Instance commands only inspect the invoking peer's syscall grant.
  const ctx = { peer: testPeer({ account: { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" }, calls }) } as KernelContext;
  return new Bash({ customCommands: buildInstanceCommands(ctx, request) });
}

describe("native instance readiness", () => {
  it("passes profile pagination through the ordinary syscall and rejects invalid offsets", async () => {
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => ({ type: "res", id: frame.id, ok: true, data: { profiles: [], total: 64 } }));
    const shell = fixture(request);
    expect((await shell.exec("browser profile list --offset 32")).exitCode).toBe(0);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ call: "sys.browser.profile.list", args: { offset: 32 } }), expect.any(AbortSignal));
    for (const offset of ["-1", "1.5", "no", "9007199254740992"]) expect((await shell.exec(`browser profile list --offset ${offset}`)).exitCode).toBe(1);
    expect(request).toHaveBeenCalledOnce();
  });
  it("keeps partial-save receipts machine-readable and warns separately without forcing stop", async () => {
    const persistence = { saveStatus: "partial" as const, savedAt: 1, issues: [{ origin: "https://unsupported.example", reason: "unsupported" as const, message: "Unsupported CryptoKey" }] };
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => ({ type: "res", id: frame.id, ok: true, data: { instance: { ...instance, state: "stopped", persistence } } }));
    const result = await fixture(request).exec("instance stop 12345678 --wait");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).instance.persistence).toEqual(persistence);
    expect(result.stderr).toContain("https://unsupported.example: Unsupported CryptoKey");
    expect(result.stderr).toContain("Other sites were saved");
    expect(request.mock.calls[0][0]).toMatchObject({ args: { force: undefined } });
  });
  it("returns a failed save status with its specific cause and diagnostic", async () => {
    const request: NonNullable<NativeShellCommandOptions["request"]> = async frame => ({ type: "res", id: frame.id, ok: true, data: { profile: { saveStatus: "failed", error: "Storage allowance exceeded", diagnosticRef: "save-diagnostic" } } });
    const result = await fixture(request).exec("browser profile save 12345678");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).profile.saveStatus).toBe("failed");
    expect(result.stderr).toContain("Storage allowance exceeded; diagnostic save-diagnostic");
  });
  it("waits for stop to release the browser and forwards an explicit force request", async () => {
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => ({
      type: "res", id: frame.id, ok: true,
      data: { instance: { ...instance, state: frame.call === "sys.instance.stop" ? "stopping" : "stopped" } },
    }));
    const result = await fixture(request).exec("instance stop 12345678 --force --wait");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).instance.state).toBe("stopped");
    expect(request.mock.calls[0][0]).toMatchObject({ call: "sys.instance.stop", args: { instanceId: "12345678", force: true } });
    expect(request.mock.calls.map(([frame]) => frame.call)).toEqual(["sys.instance.stop", "sys.instance.get"]);
  });
  it("waits for ready, retains the start receipt and never starts a second time", async () => {
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => ({
      type: "res", id: frame.id, ok: true,
      data: frame.call === "sys.instance.start" ? { instance, disposition: "reused" } : { instance: { ...instance, state: "ready" } },
    }));
    const result = await fixture(request).exec("instance start browser --request-id saved --wait");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ disposition: "reused", instance: { state: "ready", targetId: "12345678" } });
    expect(request.mock.calls.map(([frame]) => frame.call)).toEqual(["sys.instance.start", "sys.instance.get"]);
  });
  it("bounds the wait and returns recovery instructions without stopping the browser", async () => {
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => ({ type: "res", id: frame.id, ok: true, data: { instance, disposition: "created" } }));
    const result = await fixture(request).exec("instance start browser --request-id saved --wait --timeout 100");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("wait timed out");
    expect(result.stderr).toContain("instance get --request-id 'saved'");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("stops waiting when startup fails and includes the diagnostic", async () => {
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => ({ type: "res", id: frame.id, ok: true, data: { instance: { ...instance, state: "failed", diagnosticRef: "diagnostic-1" }, disposition: "created" } }));
    const result = await fixture(request).exec("instance start browser --request-id saved --wait");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("12345678 is failed; diagnostic diagnostic-1");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("cancels polling without stopping or restarting an admitted browser", async () => {
    const abort = new AbortController();
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async frame => {
      setTimeout(() => abort.abort(new Error("Cancelled by caller")), 10);
      return { type: "res", id: frame.id, ok: true, data: { instance, disposition: "created" } };
    });
    const result = await fixture(request).exec("instance start browser --request-id saved --wait", { signal: abort.signal });
    expect(result.exitCode).not.toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid waits and missing read authority before starting anything", async () => {
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>();
    for (const suffix of ["--timeout 100", "--wait --timeout 120001", "--wait --timeout nope"]) {
      expect((await fixture(request).exec(`instance start browser --request-id saved ${suffix}`)).exitCode).toBe(1);
    }
    expect((await fixture(request, ["sys.instance.start"]).exec("instance start browser --request-id saved --wait")).stderr).toContain("Permission denied: sys.instance.get");
    expect(request).not.toHaveBeenCalled();
  });
  it("reports an unknown start receipt as a failed get", async () => {
    const request: NativeShellCommandOptions["request"] = async frame => ({ type: "res", id: frame.id, ok: true, data: { instance: null } });
    const result = await fixture(request).exec("instance get --request-id missing");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No instance has been admitted");
  });
});
