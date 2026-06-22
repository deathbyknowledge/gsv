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
export type { AgentApprovalAction } from "../domain/consoleAgentBehavior";

export const DEFAULT_CONSOLE_ADAPTERS = ["whatsapp", "discord", "telegram"] as const;

export type ConsoleClient = Pick<GSVClient, "call" | "proc" | "pkg" | "account" | "sys">;

export type ConsoleAgentContextFileDraft = {
  label: string;
  name?: string;
  content: string;
  orig?: string;
};

export type ConsoleAgentContextFile = ConsoleAgentContextFileDraft & {
  name: string;
  orig: string;
};

export type CreateConsoleAgentInput = {
  name: string;
  role: string;
  description: string;
  model?: string;
  approval?: string;
  files: readonly ConsoleAgentContextFileDraft[];
};

export type CreateConsoleAgentResult = {
  uid: number | null;
  username: string;
  displayName: string;
};

export type SaveConsoleAgentContextInput = {
  username: string;
  files: readonly ConsoleAgentContextFileDraft[];
};

export type SaveConsoleAgentContextResult = {
  written: number;
};

export type SaveConsoleAgentBehaviorInput = {
  uid: number;
  model: string;
  approval: string;
};

export type SaveConsoleAgentBehaviorResult = {
  ok: true;
};

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

export async function loadConsoleAgentContext(
  client: Pick<GSVClient, "call">,
  username: string,
): Promise<ConsoleAgentContextFile[]> {
  const normalizedUsername = normalizeContextUsername(username);
  if (!normalizedUsername) {
    throw new Error("valid username is required");
  }

  const dir = contextDir(normalizedUsername);
  const listing = await client.call("fs.read", { path: dir }) as {
    ok?: boolean;
    files?: unknown;
    error?: string;
  };
  if (listing.ok === false) {
    return [];
  }

  const names = Array.isArray(listing.files)
    ? listing.files.filter((name): name is string => typeof name === "string" && name.endsWith(".md")).sort()
    : [];
  const files: ConsoleAgentContextFile[] = [];

  for (const name of names) {
    const result = await client.call("fs.read", { path: `${dir}/${name}` }) as {
      ok?: boolean;
      content?: unknown;
    };
    if (result.ok === false || typeof result.content !== "string") {
      continue;
    }
    const content = stripLineNumbers(result.content);
    files.push({
      name,
      label: displayContextFileLabel(name),
      content,
      orig: content,
    });
  }

  return files;
}

export async function createConsoleAgent(
  client: Pick<GSVClient, "account" | "sys">,
  input: CreateConsoleAgentInput,
): Promise<CreateConsoleAgentResult> {
  const displayName = input.name.trim();
  const username = usernameFromAgentName(displayName);
  if (!username) {
    throw new Error("agent name is required");
  }

  const result = await client.account.create({
    kind: "agent",
    username,
    gecos: displayName || undefined,
    persona: personaSeed(input),
    contextFiles: contextFilesFromDraft(input.files),
  });
  const account = result.account;
  const uid = Number(account.uid);
  if (Number.isFinite(uid)) {
    await saveAgentBehaviorConfig(client, uid, input);
  }

  return {
    uid: Number.isFinite(uid) ? uid : null,
    username: account.username || username,
    displayName,
  };
}

export async function saveConsoleAgentContext(
  client: Pick<GSVClient, "call">,
  input: SaveConsoleAgentContextInput,
): Promise<SaveConsoleAgentContextResult> {
  const username = normalizeContextUsername(input.username);
  if (!username) {
    throw new Error("valid username is required");
  }

  let written = 0;
  for (const file of input.files) {
    if (!isChangedContextFile(file)) {
      continue;
    }
    const name = normalizeContextFileName(file.name ?? file.label);
    if (!name) {
      throw new Error("valid context file names are required");
    }
    const result = await client.call("fs.write", {
      path: `${contextDir(username)}/${name}`,
      content: file.content,
    }) as { ok?: boolean; error?: string };
    if (result.ok === false) {
      throw new Error(result.error || `failed to write ${name}`);
    }
    written += 1;
  }

  return { written };
}

export async function saveConsoleAgentBehavior(
  client: Pick<GSVClient, "sys">,
  input: SaveConsoleAgentBehaviorInput,
): Promise<SaveConsoleAgentBehaviorResult> {
  const uid = Number(input.uid);
  if (!Number.isFinite(uid)) {
    throw new Error("uid is required");
  }
  await saveAgentBehaviorConfig(client, uid, input, { includeEmpty: true });

  return { ok: true };
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

type AgentBehaviorConfigDraft = {
  model?: string;
  approval?: string;
};

async function saveAgentBehaviorConfig(
  client: Pick<GSVClient, "sys">,
  uid: number,
  input: AgentBehaviorConfigDraft,
  options: { includeEmpty?: boolean } = {},
): Promise<void> {
  const model = input.model?.trim() ?? "";
  const approval = input.approval?.trim() ?? "";
  const writes: Promise<unknown>[] = [];

  if (options.includeEmpty || model) {
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/model`,
      value: model,
    }));
  }
  if (options.includeEmpty || approval) {
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/tools/approval`,
      value: approval,
    }));
  }

  await Promise.all(writes);
}

function usernameFromAgentName(name: string): string | null {
  const username = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!username) {
    return null;
  }
  if (/^[a-z_]/.test(username)) {
    return username;
  }
  return `a-${username}`.slice(0, 32);
}

function contextFilesFromDraft(files: readonly ConsoleAgentContextFileDraft[]):
  Array<{ name: string; text: string }> | undefined {
  const contextFiles = files
    .filter((file) => normalizeContextFileName(file.name ?? file.label) !== "05-persona.md")
    .filter(isChangedContextFile)
    .map((file) => ({
      name: normalizeContextFileName(file.name ?? file.label) ?? "context.md",
      text: file.content,
    }));

  return contextFiles.length > 0 ? contextFiles : undefined;
}

function personaSeed(input: CreateConsoleAgentInput): string | undefined {
  const personaFile = input.files.find((file) => normalizeContextFileName(file.name ?? file.label) === "05-persona.md");
  const personaText = personaFile && isChangedContextFile(personaFile) ? personaFile.content.trim() : "";
  const role = input.role.trim();
  const description = input.description.trim();
  const parts = [
    role && role.toUpperCase() !== "AGENT" ? `Role: ${role}` : "",
    personaText || description,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function isChangedContextFile(file: ConsoleAgentContextFileDraft): boolean {
  const content = file.content.trim();
  if (!content) {
    return false;
  }
  return content !== (file.orig ?? "").trim();
}

function normalizeContextFileName(label: string): string | null {
  const raw = label.trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  if (raw.toUpperCase() === "PERSONA") {
    return "05-persona.md";
  }
  const base = raw
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!base || base === "." || base === "..") {
    return null;
  }
  return `${base}.md`;
}

function normalizeContextUsername(value: string): string | null {
  const username = value.trim();
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(username) ? username : null;
}

function contextDir(username: string): string {
  return `/home/${username}/context.d`;
}

function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function displayContextFileLabel(name: string): string {
  if (name === "05-persona.md") {
    return "PERSONA";
  }
  return name
    .replace(/\.md$/i, "")
    .replace(/^\d+-/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .toUpperCase() || name.toUpperCase();
}
