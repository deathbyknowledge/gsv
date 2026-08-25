import { describe, expect, it } from "vitest";
import type { SyscallName } from "../syscalls";
import { isMasterOwnedSyscall } from "./master-syscalls";

const USER_KERNEL_INTEGRATION_SYSCALLS = [
  "sys.oauth.start",
  "sys.oauth.device.start",
  "sys.oauth.device.poll",
  "sys.oauth.list",
  "sys.oauth.forget",
  "sys.mcp.add",
  "sys.mcp.list",
  "sys.mcp.remove",
  "sys.mcp.refresh",
  "sys.mcp.call",
  "app.open",
  "app.attach",
  "app.list",
  "app.detach",
  "app.close",
  "adapter.inbound",
] satisfies SyscallName[];

describe("master syscall ownership", () => {
  it.each(USER_KERNEL_INTEGRATION_SYSCALLS)("keeps %s in the user Kernel", (call) => {
    expect(isMasterOwnedSyscall(call)).toBe(false);
  });

  it("still routes ship-wide account mutations to the master", () => {
    expect(isMasterOwnedSyscall("account.create")).toBe(true);
  });

  it.each([
    "pkg.add",
    "pkg.create",
    "pkg.sync",
    "pkg.checkout",
    "pkg.install",
    "pkg.review.approve",
    "pkg.remove",
    "pkg.remote.add",
    "pkg.remote.remove",
    "pkg.public.set",
  ] satisfies SyscallName[])("routes %s directly to the Master", (call) => {
    expect(isMasterOwnedSyscall(call)).toBe(true);
  });

  it("does not infer Master ownership from a namespace prefix", () => {
    const futurePackageCall = "pkg.future.data-plane" as SyscallName;
    const futureAccountCall = "account.future.local" as SyscallName;
    const futureAdapterCall = "adapter.future.local" as SyscallName;

    expect(isMasterOwnedSyscall(futurePackageCall)).toBe(false);
    expect(isMasterOwnedSyscall(futureAccountCall)).toBe(false);
    expect(isMasterOwnedSyscall(futureAdapterCall)).toBe(false);
  });
});
