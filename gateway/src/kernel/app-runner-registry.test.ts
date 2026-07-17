import { describe, expect, it, vi } from "vitest";
import { AppRunnerRegistry } from "./app-runner-registry";

describe("AppRunnerRegistry", () => {
  it("registers the deterministic runner name at the Kernel boundary", () => {
    const exec = vi.fn((statement: string) => {
      if (statement.startsWith("SELECT *")) {
        return {
          one: () => ({
            runner_name: "app:42:package-id",
            uid: 42,
            package_id: "package-id",
            created_at: 1,
            updated_at: 2,
          }),
        };
      }
      return {};
    });
    const registry = new AppRunnerRegistry({ exec } as unknown as SqlStorage);

    expect(registry.register(42, "package-id")).toEqual({
      runnerName: "app:42:package-id",
      uid: 42,
      packageId: "package-id",
      createdAt: 1,
      updatedAt: 2,
    });
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(uid, package_id)"),
      "app:42:package-id",
      42,
      "package-id",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("rejects identities that cannot name a durable runner", () => {
    const registry = new AppRunnerRegistry({} as SqlStorage);
    expect(() => registry.register(-1, "package-id")).toThrow("Invalid app runner identity");
    expect(() => registry.register(42, " ")).toThrow("Invalid app runner identity");
  });
});
