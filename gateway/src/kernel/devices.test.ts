import { describe, it, expect } from "vitest";
import { DeviceRegistry } from "./devices";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";

describe("DeviceRegistry", () => {
  const registryTest = it.extend<{ registry: DeviceRegistry }>({
    registry: async ({ task: _task }, use) => {
      await runWithRealKernelSql((sql) => use(new DeviceRegistry(sql)));
    },
  });

  registryTest("registers a new device", ({ registry }) => {
    const result = registry.register(
      "macbook",
      1000,
      1000,
      ["fs.*", "proc.*"],
      "darwin-arm64",
      "0.1.0",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true);

    const device = registry.get("macbook");
    expect(device).not.toBeNull();
    expect(device!.device_id).toBe("macbook");
    expect(device!.owner_uid).toBe(1000);
    expect(device!.label).toBe("macbook");
    expect(device!.description).toBe("");
    expect(device!.implements).toEqual(["fs.*", "proc.*"]);
    expect(device!.online).toBe(true);
  });

  registryTest("rejects invalid implements patterns", ({ registry }) => {
    const result = registry.register(
      "bad",
      1000,
      1000,
      ["not valid!"],
      "linux",
      "0.1.0",
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain("Invalid implements pattern");
  });

  registryTest(
    "re-registers an existing device (reconnect)",
    ({ registry }) => {
      registry.register("server", 1000, 1000, ["fs.*"], "linux", "0.1.0");
      registry.setDescription("server", "Linux home server");
      registry.setOnline("server", false);

      const device = registry.get("server");
      expect(device!.online).toBe(false);

      const reconnected = registry.register(
        "server",
        1000,
        1000,
        ["fs.*", "proc.*"],
        "linux",
        "0.2.0",
      );
      expect(reconnected).toMatchObject({ ok: true, created: false });
      const updated = registry.get("server");
      expect(updated!.online).toBe(true);
      expect(updated!.version).toBe("0.2.0");
      expect(updated!.implements).toEqual(["fs.*", "proc.*"]);
      expect(updated!.description).toBe("Linux home server");
      expect(updated!.label).toBe("server");
    },
  );

  registryTest(
    "rejects registration when a device id belongs to another owner",
    ({ registry }) => {
      registry.register("server", 1000, 1000, ["fs.*"], "linux", "0.1.0");
      registry.setMetadata("server", {
        label: "Old Server",
        description: "Old owner note",
      });

      const result = registry.register(
        "server",
        2000,
        2000,
        ["fs.*"],
        "linux",
        "0.2.0",
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toContain("already belongs to another user");

      const updated = registry.get("server");
      expect(updated!.owner_uid).toBe(1000);
      expect(updated!.label).toBe("Old Server");
      expect(updated!.description).toBe("Old owner note");
    },
  );

  registryTest("stores owner-authored device metadata", ({ registry }) => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");

    expect(
      registry.setMetadata("macbook", {
        label: "  Laptop  ",
        description: "  Personal MacBook  ",
      }),
    ).toBe(true);
    expect(registry.get("macbook")!.label).toBe("Laptop");
    expect(registry.get("macbook")!.description).toBe("Personal MacBook");
    expect(registry.setDescription("missing", "nope")).toBe(false);
  });

  registryTest("stores registration metadata", ({ registry }) => {
    const result = registry.register(
      "browser-extension",
      1000,
      1000,
      ["fs.read", "shell.exec"],
      "browser",
      "0.1.0",
      {
        label: "Browser Target",
        description: "Active browser",
      },
    );
    expect(result.ok).toBe(true);

    const device = registry.get("browser-extension");
    expect(device?.label).toBe("Browser Target");
    expect(device?.description).toBe("Active browser");
  });

  registryTest("marks a device disconnected", ({ registry }) => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.setOnline("macbook", false);

    const device = registry.get("macbook");
    expect(device!.online).toBe(false);
    expect(device!.disconnected_at).not.toBeNull();
  });

  registryTest("removes device records and access entries", ({ registry }) => {
    registry.register("macbook", 1000, 1000, ["fs.read"], "darwin", "0.1.0");
    registry.grantAccess("macbook", 100);

    expect(registry.remove("macbook")).toBe(true);
    expect(registry.get("macbook")).toBeNull();
    expect(registry.listAccess("macbook")).toEqual([]);
    expect(registry.remove("macbook")).toBe(false);
  });

  registryTest("listOnline returns only online devices", ({ registry }) => {
    registry.register("a", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("b", 1000, 1000, ["proc.*"], "linux", "0.1.0");
    registry.setOnline("b", false);

    const online = registry.listOnline();
    expect(online).toHaveLength(1);
    expect(online[0].device_id).toBe("a");
  });

  registryTest("returns null for unknown device", ({ registry }) => {
    expect(registry.get("nonexistent")).toBeNull();
  });

  registryTest(
    "creates default access for owner's gid on register",
    ({ registry }) => {
      registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
      const access = registry.listAccess("macbook");
      expect(access).toEqual([1000]);
    },
  );

  registryTest(
    "canAccess grants root (uid 0) unconditionally",
    ({ registry }) => {
      registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
      expect(registry.canAccess("macbook", 0, [0])).toBe(true);
    },
  );

  registryTest("canAccess grants owner", ({ registry }) => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    expect(registry.canAccess("macbook", 1000, [1000])).toBe(true);
  });

  registryTest("canAccess grants group members", ({ registry }) => {
    registry.register("team-server", 0, 0, ["fs.*"], "linux", "0.1.0");
    registry.grantAccess("team-server", 100); // users group

    expect(registry.canAccess("team-server", 1000, [1000, 100])).toBe(true);
    expect(registry.canAccess("team-server", 1001, [1001, 200])).toBe(false);
  });

  registryTest("canAccess denies non-owner non-group user", ({ registry }) => {
    registry.register("alice-laptop", 1001, 1001, ["fs.*"], "darwin", "0.1.0");
    expect(registry.canAccess("alice-laptop", 1000, [1000, 100])).toBe(false);
  });

  registryTest("canHandle checks implements patterns", ({ registry }) => {
    registry.register(
      "macbook",
      1000,
      1000,
      ["fs.*", "proc.exec"],
      "darwin",
      "0.1.0",
    );

    expect(registry.canHandle("macbook", "fs.read")).toBe(true);
    expect(registry.canHandle("macbook", "fs.write")).toBe(true);
    expect(registry.canHandle("macbook", "proc.exec")).toBe(true);
    expect(registry.canHandle("macbook", "proc.list")).toBe(false);
    expect(registry.canHandle("macbook", "adapter.send")).toBe(false);
  });

  registryTest(
    "findDevice finds accessible device that implements syscall",
    ({ registry }) => {
      registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
      registry.register("server", 0, 0, ["fs.*", "proc.*"], "linux", "0.1.0");
      registry.grantAccess("server", 100);

      const device = registry.findDevice("proc.exec", 1000, [1000, 100]);
      expect(device).not.toBeNull();
      expect(device!.device_id).toBe("server");
    },
  );

  registryTest(
    "findDevice returns null when no device matches",
    ({ registry }) => {
      registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
      expect(registry.findDevice("adapter.send", 1000, [1000])).toBeNull();
    },
  );

  registryTest("grantAccess and revokeAccess work", ({ registry }) => {
    registry.register("server", 0, 0, ["fs.*"], "linux", "0.1.0");
    registry.grantAccess("server", 100);
    expect(registry.listAccess("server")).toEqual([0, 100]);

    registry.revokeAccess("server", 100);
    expect(registry.listAccess("server")).toEqual([0]);
  });

  registryTest(
    "listForUser returns owned and group-accessible devices",
    ({ registry }) => {
      registry.register("sam-laptop", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
      registry.register(
        "alice-laptop",
        1001,
        1001,
        ["fs.*"],
        "darwin",
        "0.1.0",
      );
      registry.register(
        "team-server",
        0,
        0,
        ["fs.*", "proc.*"],
        "linux",
        "0.1.0",
      );
      registry.grantAccess("team-server", 100);

      const samDevices = registry.listForUser(1000, [1000, 100]);
      const ids = samDevices.map((d) => d.device_id);
      expect(ids).toContain("sam-laptop");
      expect(ids).toContain("team-server");
      expect(ids).not.toContain("alice-laptop");
    },
  );

  registryTest("listForUser root sees all devices", ({ registry }) => {
    registry.register("a", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("b", 1001, 1001, ["proc.*"], "linux", "0.1.0");

    const all = registry.listForUser(0, [0]);
    expect(all).toHaveLength(2);
  });

  registryTest(
    "listForUser with no group access returns only owned",
    ({ registry }) => {
      registry.register("mine", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
      registry.register("not-mine", 1001, 1001, ["fs.*"], "darwin", "0.1.0");

      const devices = registry.listForUser(1000, []);
      expect(devices).toHaveLength(1);
      expect(devices[0].device_id).toBe("mine");
    },
  );
});
