import type { ResponseFrame } from "../protocol/frames";
import { describe, expect, it } from "vitest";
import { ROOT_IDENTITY, initProcess, makeReq } from "./do-test-harness";

describe("unknown command", () => {
  it("returns error for unknown call", async () => {
    const pid = "mech-unknown";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const res = (await stub.recvFrame(
      makeReq("proc.bogus", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseFrame;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Unknown process command");
    }
  });
});
