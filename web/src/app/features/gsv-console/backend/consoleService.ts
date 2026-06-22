import type { GSVClient } from "@humansandmachines/gsv/client";
import {
  buildConsoleOverviewData,
  normalizeAccountsPayload,
  normalizeAdapterStatusPayload,
  normalizeConfigPayload,
  normalizePackagesPayload,
  normalizeProcessesPayload,
  normalizeTargetsPayload,
} from "../domain/consoleNormalization";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";

export const DEFAULT_CONSOLE_ADAPTERS = ["whatsapp", "discord", "telegram"] as const;

export type ConsoleClient = Pick<GSVClient, "call" | "proc" | "pkg" | "account" | "sys">;

export type LoadConsoleOverviewOptions = {
  adapters?: readonly string[];
  includeConfig?: boolean;
};

export async function loadConsoleProcesses(client: Pick<GSVClient, "proc">): Promise<ConsoleProcess[]> {
  return normalizeProcessesPayload(await client.proc.list({}));
}

export async function loadConsoleTargets(client: ConsoleClient): Promise<ConsoleTarget[]> {
  return normalizeTargetsPayload(await client.call("sys.device.list", { includeOffline: true }));
}

export async function loadConsolePackages(client: Pick<GSVClient, "pkg">): Promise<ConsolePackage[]> {
  return normalizePackagesPayload(await client.pkg.list({}));
}

export async function loadConsoleAccounts(client: Pick<GSVClient, "account">): Promise<ConsoleAccount[]> {
  return normalizeAccountsPayload(await client.account.list({}));
}

export async function loadConsoleConfig(client: ConsoleClient): Promise<ConsoleConfigEntry[]> {
  return normalizeConfigPayload(await client.sys.config.get({}));
}

export async function loadConsoleAdapterAccounts(
  client: Pick<GSVClient, "call">,
  adapters: readonly string[] = DEFAULT_CONSOLE_ADAPTERS,
): Promise<ConsoleAdapterAccount[]> {
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => normalizeAdapterStatusPayload(
      await client.call("adapter.status", { adapter }),
      adapter,
    )),
  );

  return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export async function loadConsoleOverview(
  client: ConsoleClient,
  options: LoadConsoleOverviewOptions = {},
): Promise<ConsoleOverviewData> {
  const adapters = options.adapters ?? DEFAULT_CONSOLE_ADAPTERS;
  const includeConfig = options.includeConfig ?? true;

  const [
    processes,
    targets,
    packagesResult,
    accounts,
    adapterResults,
    config,
  ] = await Promise.all([
    client.proc.list({}),
    client.call("sys.device.list", { includeOffline: true }),
    client.pkg.list({}),
    client.account.list({}),
    loadAdapterPayloads(client, adapters),
    includeConfig ? loadOptionalPayload(() => client.sys.config.get({})) : Promise.resolve({ entries: [] }),
  ]);

  return buildConsoleOverviewData({
    loadedAt: Date.now(),
    processes,
    targets,
    packages: packagesResult,
    accounts,
    adapters: adapterResults,
    config,
  });
}

async function loadAdapterPayloads(client: Pick<GSVClient, "call">, adapters: readonly string[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        return await client.call("adapter.status", { adapter });
      } catch {
        return { adapter, accounts: [] };
      }
    }),
  );

  return settled.map((result) => result.status === "fulfilled" ? result.value : { accounts: [] });
}

async function loadOptionalPayload(load: () => Promise<unknown>): Promise<unknown> {
  try {
    return await load();
  } catch {
    return {};
  }
}
