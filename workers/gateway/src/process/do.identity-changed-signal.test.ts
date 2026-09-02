import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { runInProcess, ROOT_IDENTITY, initProcess } from "./do-test-harness";

describe("identity.changed signal", () => {
  it("updates stored identity on signal", async () => {
    const pid = "mech-sig-identity";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const newIdentity: ProcessIdentity = {
      uid: 0,
      gid: 0,
      gids: [0, 42],
      username: "root",
      home: "/root",
      cwd: "/root",
    };

    // SAFETY: test fixture is constructed with the asserted domain shape.

    await stub.recvFrame({
      type: "sig",
      signal: "identity.changed",
      payload: { identity: newIdentity },
      // SAFETY: test fixture is constructed with the asserted domain shape.
    } as any);

    await runInProcess(stub, (process) => {
      expect(process.identity.gids).toEqual([0, 42]);
    });
  });
});
