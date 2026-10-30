import { GSVClient } from "@humansandmachines/gsv/client";
import { vi } from "vitest";
import { z } from "zod";
import type { ConsoleConfigEntry } from "../../../domain/system/consoleModels";

const configReadSchema = z.object({ key: z.string().optional() });
const configWriteSchema = z.object({ key: z.string(), value: z.string() });
type ConfigWrite = z.infer<typeof configWriteSchema>;

export function settingsGatewayFixture(initialConfig: ConsoleConfigEntry[] = []) {
  let config = initialConfig;
  const write = vi.fn(async (entry: ConfigWrite) => {
    config = [...config.filter((current) => current.key !== entry.key), { ...entry, redacted: false }];
    return { ok: true };
  });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({
    state: "connected", url: "wss://ship.example/ws", username: "owner", connectionId: null, message: null,
  });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "sys.config.get") {
      const { key } = configReadSchema.parse(args);
      return { data: { entries: key ? config.filter((entry) => entry.key === key) : config } };
    }
    if (call === "sys.config.set") return { data: await write(configWriteSchema.parse(args)) };
    if (call === "ai.models") return { data: { models: [], preferredModelId: null } };
    if (call === "sys.target.list") return { data: { targets: [] } };
    if (call === "sys.link.list") return { data: { links: [] } };
    if (call === "adapter.list") return { data: { adapters: ["whatsapp", "telegram", "slack", "discord"].map((adapter) => ({
      adapter, available: true, enabled: true, supportsPairing: true, canLink: true, accounts: [],
    })) } };
    throw new Error(`Unexpected settings request: ${call}`);
  });
  return { write };
}
