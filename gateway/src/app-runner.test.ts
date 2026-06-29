import { describe, expect, it } from "vitest";
import { appRunnerWorkerCodeKey } from "./app-runner";

function baseProps(runtimeAccess?: Parameters<typeof appRunnerWorkerCodeKey>[0]["artifact"]["runtimeAccess"]) {
  return {
    appFrame: { uid: 1000 },
    packageId: "pkg-chat",
    artifact: {
      hash: "sha256:abc123",
      ...(runtimeAccess ? { runtimeAccess } : {}),
    },
  };
}

describe("appRunnerWorkerCodeKey", () => {
  it("changes when package runtime access changes", () => {
    const denied = appRunnerWorkerCodeKey(baseProps({ egress: { mode: "none" } }));
    const allowed = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "allowlist", allow: ["api.example.com"] },
    }));

    expect(allowed).not.toBe(denied);
  });

  it("normalizes runtime access object key order", () => {
    const first = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "none" },
      daemon: { rpcSchedules: true },
      storage: { sql: true },
    }));
    const second = appRunnerWorkerCodeKey(baseProps({
      storage: { sql: true },
      daemon: { rpcSchedules: true },
      egress: { mode: "none" },
    }));

    expect(second).toBe(first);
  });
});
