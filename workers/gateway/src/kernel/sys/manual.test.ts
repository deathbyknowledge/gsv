import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RipgitClient } from "../../fs/ripgit/client";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { handleRepoDelete } from "../repo";
import { ManualUpdater, type ManualUpdateState } from "./manual";
import manualVersion from "./manual-version.json";

function fixture() {
  const data = new Map<string, ManualUpdateState>();
  const values = new Map<string, string>([["repos/root/gsv-manual/created_at", "1"]]);
  // SAFETY: the updater only uses get/put/delete for its opaque ManualUpdateState record.
  const storage = { kv: {
    get: (key: string) => data.get(key),
    put: (key: string, value: ManualUpdateState) => { data.set(key, value); },
    delete: (key: string) => data.delete(key),
  } as DurableObjectStorage["kv"] };
  const ctx = {
    // SAFETY: RipgitClient.importFromUpstream is mocked; no fetcher methods are used.
    env: { RIPGIT: {} as Fetcher } as KernelContext["env"],
    // SAFETY: ManualUpdater and registration only use these ConfigStore operations.
    config: { get: (key: string) => values.get(key) ?? null,
      delete: (key: string) => values.delete(key),
      set: (key: string, value: string) => { values.set(key, value); } } as KernelContext["config"],
  };
  const canUpdate = vi.fn(async () => true);
  const reload = () => new ManualUpdater(storage, ctx, canUpdate);
  const manual = reload();
  // SAFETY: root deletion needs only the principal, config, Manual updater, and mocked Ripgit client.
  const kernel = { ...ctx, manual, peer: testPeer({ account: {
    uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root",
  }, calls: ["*"] }) } as KernelContext;
  const deleteManual = () => handleRepoDelete({ repo: "root/gsv-manual" }, kernel);
  return { data, values, storage, ctx, canUpdate, reload, manual, deleteManual };
}

const importUpstream = vi.spyOn(RipgitClient.prototype, "importFromUpstream");
const deleteRepository = vi.spyOn(RipgitClient.prototype, "deleteRepository");
const imported = { remoteUrl: manualVersion.repository, remoteRef: manualVersion.revision,
  head: manualVersion.revision, changed: true };

beforeEach(() => {
  vi.clearAllMocks();
  importUpstream.mockReset().mockResolvedValue(imported);
  deleteRepository.mockReset().mockResolvedValue(true);
});

afterEach(() => { vi.spyOn(Date, "now").mockRestore(); });

describe("automatic Manual updates", () => {
  it("upgrades an existing installation once and remembers success across eviction", async () => {
    const f = fixture();
    await f.manual.ensureCurrent();
    await f.reload().ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(1);
    expect(importUpstream.mock.calls[0]?.slice(-2)).toEqual([manualVersion.repository, manualVersion.revision]);
    expect(f.manual.status()).toMatchObject({ status: "current", head: manualVersion.revision });
  });

  it("shares an in-flight refresh with explicit refreshes", async () => {
    const f = fixture();
    let finish!: () => void;
    importUpstream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return imported;
    });
    const automatic = f.manual.ensureCurrent();
    await vi.waitFor(() => expect(importUpstream).toHaveBeenCalledTimes(1));
    const explicit = f.manual.refresh();
    await f.manual.ensureCurrent();
    expect(f.manual.status()?.status).toBe("updating");
    finish();
    await Promise.all([automatic, explicit]);
    expect(importUpstream).toHaveBeenCalledTimes(1);
  });

  it("keeps local modifications visible and does not repeatedly fetch a divergent copy", async () => {
    const f = fixture();
    importUpstream.mockResolvedValue({ ...imported, head: "local-edit", changed: false, diverged: true });
    await f.manual.ensureCurrent();
    await f.reload().ensureCurrent();
    expect(f.manual.status()).toMatchObject({ status: "diverged", head: "local-edit" });
    expect(importUpstream).toHaveBeenCalledTimes(1);
  });

  it("retries failures on later activity, without throwing into the caller or spinning after eviction", async () => {
    const f = fixture();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    importUpstream.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(f.manual.ensureCurrent()).resolves.toBeUndefined();
    await f.reload().ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(1);
    expect(f.manual.status()?.status).toBe("failed");
    now += 5 * 60_000;
    await f.reload().ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(2);
    expect(f.manual.status()?.status).toBe("current");
  });

  it("recovers an interrupted refresh after the retry interval", async () => {
    const f = fixture();
    await f.manual.refresh();
    f.data.set("manual_update", { ...f.manual.status()!, status: "updating", checkedAt: 0 });
    await f.reload().ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(2);
  });

  it("updates again when the configured revision changes, preserving custom upstream selection", async () => {
    const f = fixture();
    await f.manual.ensureCurrent();
    Object.assign(f.ctx.env, { GSV_MANUAL_BOOTSTRAP_UPSTREAM: "example/manual#stable", GSV_MANUAL_BOOTSTRAP_REF: "v2" });
    await f.reload().ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(2);
    expect(importUpstream.mock.calls[1]?.slice(-2)).toEqual(["https://github.com/example/manual", "v2"]);
  });

  it("does not start before onboarding, without Ripgit, or while installation admission is closed", async () => {
    const f = fixture();
    f.values.clear();
    await f.manual.ensureCurrent();
    expect(importUpstream).not.toHaveBeenCalled();
    f.values.set("repos/root/gsv-manual/created_at", "1");
    f.canUpdate.mockResolvedValue(false);
    await f.manual.ensureCurrent();
    expect(importUpstream).not.toHaveBeenCalled();
    delete f.ctx.env.RIPGIT;
    await f.manual.ensureCurrent();
    expect(importUpstream).not.toHaveBeenCalled();
  });

  it("refreshes the Manual without seeding or altering account skills", async () => {
    const apply = vi.spyOn(RipgitClient.prototype, "apply");
    await fixture().manual.refresh();
    expect(apply).not.toHaveBeenCalled();
  });

  it("cancels an update still waiting for installation admission when the Manual is deleted", async () => {
    const f = fixture();
    let admit!: () => void;
    f.canUpdate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { admit = resolve; });
      return true;
    });
    const update = f.manual.ensureCurrent();
    await f.deleteManual();
    admit();
    await update;
    await f.reload().ensureCurrent();
    expect(importUpstream).not.toHaveBeenCalled();
    expect(f.manual.status()).toBeUndefined();
    expect(f.values.has("repos/root/gsv-manual/created_at")).toBe(false);
  });

  it.each([false, true])("ignores late import results after deletion (failed: %s)", async (fail) => {
    const f = fixture();
    let finish!: () => void;
    importUpstream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      if (fail) throw new Error("upstream failed after deletion");
      return imported;
    });
    const update = f.manual.refresh();
    const rejected = expect(update).rejects.toThrow(fail
      ? "upstream failed after deletion" : "Manual update cancelled by repository deletion");
    let finishDelete!: () => void;
    deleteRepository.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishDelete = resolve; });
      return true;
    });
    const deletion = f.deleteManual();
    await f.manual.ensureCurrent();
    await expect(f.manual.refresh()).rejects.toThrow("Manual repository is being deleted");
    finishDelete();
    await deletion;
    finish();
    await rejected;
    await f.reload().ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(1);
    expect(f.manual.status()).toBeUndefined();
    expect(f.values.size).toBe(0);
  });

  it("can explicitly reinstall after deletion without an old completion changing the new update", async () => {
    const f = fixture();
    let finishOld!: () => void;
    let finishNew!: () => void;
    importUpstream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishOld = resolve; });
      return imported;
    }).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishNew = resolve; });
      return imported;
    });
    const old = expect(f.manual.refresh()).rejects.toThrow("Manual update cancelled by repository deletion");
    await f.deleteManual();
    const reinstall = f.manual.refresh();
    finishOld();
    await old;
    expect(f.manual.refresh()).toBe(reinstall);
    expect(f.manual.status()?.status).toBe("updating");
    finishNew();
    await reinstall;
    expect(f.manual.status()?.status).toBe("current");
    expect(f.values.has("repos/root/gsv-manual/created_at")).toBe(true);
    expect(importUpstream).toHaveBeenCalledTimes(2);
  });

  it("resumes automatic updates if deletion fails", async () => {
    const f = fixture();
    await f.manual.ensureCurrent();
    deleteRepository.mockRejectedValueOnce(new Error("delete failed"));
    await expect(f.deleteManual()).rejects.toThrow("delete failed");
    await f.manual.ensureCurrent();
    expect(importUpstream).toHaveBeenCalledTimes(2);
    expect(f.manual.status()?.status).toBe("current");
    expect(f.values.has("repos/root/gsv-manual/created_at")).toBe(true);
  });
});
