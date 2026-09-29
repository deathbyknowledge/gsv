import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { deferred, runInProcess, ROOT_IDENTITY, initProcess } from "./do-test-harness";

const IDENTITY_WITH_SUPPLEMENTARY_GROUP: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0, 42],
  username: "root",
  home: "/root",
  cwd: "/root",
};

function identityChangedFrame() {
  // SAFETY: test fixture is constructed with the asserted domain shape.
  return {
    type: "sig",
    signal: "identity.changed",
    payload: { identity: IDENTITY_WITH_SUPPLEMENTARY_GROUP },
  } as any;
}

describe("identity.changed signal", () => {
  it("updates stored identity on signal", async () => {
    const pid = "mech-sig-identity";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await stub.recvFrame(identityChangedFrame());

    await runInProcess(stub, (process) => {
      expect(process.identity.gids).toEqual([0, 42]);
    });
  });

  it("applies an identity update after an in-flight reset", async () => {
    const pid = "mech-sig-identity-during-reset";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: archiveBlocked, resolve: releaseArchive } = deferred();
      const { promise: archiveStarted, resolve: markArchiveStarted } = deferred();
      process.history.archiveHistoryMessages = vi.fn(async () => {
        markArchiveStarted();
        await archiveBlocked;
        return { archivedMessages: 1, archivedTo: "/archive/", archives: [] };
      });
      process.store.messages.appendMessage("user", "reset before identity update");

      const resetting = process.controller.handleProcReset();
      await archiveStarted;
      const updatingIdentity = process.controller.recvFrame(identityChangedFrame());

      expect(process.identity.gids).toEqual([0]);
      releaseArchive();
      await Promise.all([resetting, updatingIdentity]);

      expect(process.identity.gids).toEqual([0, 42]);
    });
  });
});
