import { getProcessByPid } from "../shared/utils";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import {
  runInProcess, ROOT_IDENTITY, initProcess, makeReq, registerInKernel,
} from "./do-test-harness";

describe("proc.setidentity", () => {
  it("derives pid and stores identity", async () => {
    const pid = "mech-setid-1";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      expect(process.pid).toBe(pid);
      expect(process.identity.uid).toBe(0);
      expect(process.identity.username).toBe("root");
      expect(process.identity.home).toBe("/root");
    });
  });

  it("overwrites on re-call", async () => {
    const pid = "mech-setid-2";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const newIdentity: ProcessIdentity = {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    };
    await stub.recvFrame(makeReq("proc.setidentity", { identity: newIdentity }));

    await runInProcess(stub, (process) => {
      expect(process.identity.uid).toBe(1000);
      expect(process.identity.username).toBe("alice");
    });
  });

  it("stores the process's initial task title", async () => {
    const pid = "mech-setid-title";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await getProcessByPid(pid);

    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        title: "  Explicit task title  ",
        autoTitle: true,
      }),
    );

    await runInProcess(stub, (process) => {
      expect(process.store.state.getValue("taskTitle")).toBe("Explicit task title");
      expect(process.store.state.getValue("autoTaskTitle")).toBeNull();
    });
  });
});
