import type { KernelClientLike } from "@humansandmachines/gsv/sdk/backend";
import { AI_FIELDS, buildUserAiOverrideKey } from "../app/features/settings/config-schema";
import { profileValuesFromDrafts, readModelProfiles } from "../app/features/settings/model-profiles-domain";
import type {
  AgentContextFile,
  AgentContextResult,
  AgentDetail,
  AgentMutationResult,
  AgentsState,
  CreateAgentArgs,
  CreateHumanArgs,
  LoadAgentContextArgs,
  SaveAgentContextArgs,
  SetAgentBehaviorArgs,
} from "../app/features/agents/types";

type AgentsRuntime = { viewer?: { uid?: number; username?: string } };

type AccountSummary = {
  uid: number;
  username: string;
  displayName: string;
  relation: "self" | "personal-agent" | "agent" | "human";
  runnable: boolean;
  gecos?: string;
};

type ConfigEntry = { key: string; value: string };

const ACCOUNT_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asAccounts(value: unknown): AccountSummary[] {
  const record = value && typeof value === "object" ? value as { accounts?: unknown } : {};
  return Array.isArray(record.accounts) ? record.accounts as AccountSummary[] : [];
}

function configValue(entries: ConfigEntry[], key: string): string | undefined {
  return entries.find((entry) => entry.key === key)?.value;
}

function contextDir(username: string): string {
  return `/home/${username}/context.d`;
}

function configValues(entries: ConfigEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function agentAiOverrides(values: Record<string, string>, uid: number): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const field of AI_FIELDS) {
    const value = values[buildUserAiOverrideKey(uid, field.key)];
    if (value !== undefined) {
      overrides[field.key] = value;
    }
  }
  return overrides;
}

function effectiveAgentAiValues(systemAiValues: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  return profileValuesFromDrafts({ ...systemAiValues, ...overrides });
}

function normalizeContextUsername(value: unknown): string | null {
  const username = String(value ?? "").trim();
  return ACCOUNT_USERNAME_RE.test(username) ? username : null;
}

function normalizeContextFileName(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const base = raw.endsWith(".md") ? raw.slice(0, -3) : raw;
  if (!base || base === "." || base === "..") {
    return null;
  }
  return raw.endsWith(".md") ? raw : `${raw}.md`;
}

// fs.read returns text with a `<6-space-number>\t` prefix per line; strip it so
// the editor sees the raw file content.
function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

export async function loadAgentsState(
  kernel: KernelClientLike,
  runtime: AgentsRuntime,
): Promise<AgentsState> {
  const viewerUid = typeof runtime.viewer?.uid === "number" ? runtime.viewer.uid : 0;
  const isRoot = viewerUid === 0;

  try {
    const [accountsPayload, configPayload] = await Promise.all([
      kernel.request("account.list", {}),
      kernel.request("sys.config.get", {}) as Promise<{ entries?: unknown }>,
    ]);
    const accounts = asAccounts(accountsPayload);
    const entries = Array.isArray(configPayload.entries)
      ? configPayload.entries as ConfigEntry[]
      : [];
    const values = configValues(entries);
    const systemAiValues = profileValuesFromDrafts(values);

    const agents: AgentDetail[] = accounts
      .filter((account) => account.relation === "personal-agent" || account.relation === "agent")
      .map((account) => {
        const aiValues = agentAiOverrides(values, account.uid);
        return {
          uid: account.uid,
          username: account.username,
          displayName: account.displayName,
          gecos: account.gecos,
          relation: account.relation,
          runnable: account.runnable,
          configEditable: true,
          contextEditable: true,
          model: aiValues["config/ai/model"] ?? "",
          aiValues,
          effectiveAiValues: effectiveAgentAiValues(systemAiValues, aiValues),
          approval: configValue(entries, `users/${account.uid}/ai/tools/approval`) ?? "",
        };
      });

    const humans: AccountSummary[] = accounts.filter(
      (account) => account.relation === "human" || account.relation === "self",
    );

    return {
      agents,
      humans,
      modelProfiles: readModelProfiles(values, viewerUid),
      systemAiValues,
      viewerUid,
      isRoot,
      errorText: "",
    };
  } catch (error) {
    return { agents: [], humans: [], modelProfiles: [], systemAiValues: {}, viewerUid, isRoot, errorText: errorText(error) };
  }
}

export async function loadAgentContext(
  kernel: KernelClientLike,
  args: LoadAgentContextArgs,
): Promise<AgentContextResult> {
  const username = normalizeContextUsername(args.username);
  if (!username) {
    return { files: [], errorText: "valid username is required" };
  }
  try {
    const dir = contextDir(username);
    const listing = await kernel.request("fs.read", { path: dir }) as {
      ok?: boolean;
      files?: unknown;
      error?: string;
    };
    if (listing.ok === false) {
      return { files: [], errorText: listing.error ?? "" };
    }
    const names = Array.isArray(listing.files)
      ? (listing.files as string[]).filter((name) => name.endsWith(".md")).sort()
      : [];

    const files: AgentContextFile[] = [];
    for (const name of names) {
      const file = await kernel.request("fs.read", { path: `${dir}/${name}` }) as {
        ok?: boolean;
        content?: unknown;
      };
      const content = typeof file.content === "string" ? stripLineNumbers(file.content) : "";
      files.push({ name, text: content });
    }
    return { files, errorText: "" };
  } catch (error) {
    return { files: [], errorText: errorText(error) };
  }
}

export async function saveAgentContext(
  kernel: KernelClientLike,
  args: SaveAgentContextArgs,
): Promise<AgentMutationResult> {
  const username = normalizeContextUsername(args.username);
  const fileName = normalizeContextFileName(args.name);
  if (!username || !fileName) {
    return { ok: false, errorText: "valid username and file name are required" };
  }
  try {
    const result = await kernel.request("fs.write", {
      path: `${contextDir(username)}/${fileName}`,
      content: String(args.text ?? ""),
    }) as { ok?: boolean; error?: string };
    if (result.ok === false) {
      return { ok: false, errorText: result.error ?? "write failed" };
    }
    return { ok: true, errorText: "" };
  } catch (error) {
    return { ok: false, errorText: errorText(error) };
  }
}

export async function setAgentBehavior(
  kernel: KernelClientLike,
  args: SetAgentBehaviorArgs,
): Promise<AgentMutationResult> {
  const uid = Number(args.uid);
  if (!Number.isFinite(uid)) {
    return { ok: false, errorText: "uid is required" };
  }
  try {
    if (args.aiValues !== undefined) {
      for (const field of AI_FIELDS) {
        await kernel.request("sys.config.set", {
          key: buildUserAiOverrideKey(uid, field.key),
          value: String(args.aiValues[field.key] ?? "").trim(),
        });
      }
    } else if (args.model !== undefined) {
      await kernel.request("sys.config.set", {
        key: `users/${uid}/ai/model`,
        value: String(args.model).trim(),
      });
    }
    if (args.approval !== undefined) {
      await kernel.request("sys.config.set", {
        key: `users/${uid}/ai/tools/approval`,
        value: String(args.approval).trim(),
      });
    }
    return { ok: true, errorText: "" };
  } catch (error) {
    return { ok: false, errorText: errorText(error) };
  }
}

export async function createAgent(
  kernel: KernelClientLike,
  args: CreateAgentArgs,
): Promise<AgentMutationResult> {
  const username = String(args.username ?? "").trim();
  if (!username) {
    return { ok: false, errorText: "username is required" };
  }
  const contextFiles = new Map<string, AgentContextFile>();
  if (Array.isArray(args.contextFiles)) {
    for (const file of args.contextFiles) {
      const name = normalizeContextFileName(file?.name);
      if (!name) {
        return { ok: false, errorText: "valid context file names are required" };
      }
      contextFiles.set(name, { name, text: String(file.text ?? "") });
    }
  }
  try {
    await kernel.request("account.create", {
      kind: "agent",
      username,
      gecos: String(args.gecos ?? "").trim() || undefined,
      persona: String(args.persona ?? "").trim() || undefined,
      contextFiles: contextFiles.size > 0 ? [...contextFiles.values()] : undefined,
    });
    return { ok: true, errorText: "" };
  } catch (error) {
    return { ok: false, errorText: errorText(error) };
  }
}

export async function createHuman(
  kernel: KernelClientLike,
  args: CreateHumanArgs,
): Promise<AgentMutationResult> {
  const username = String(args.username ?? "").trim();
  const password = String(args.password ?? "");
  if (!username) {
    return { ok: false, errorText: "username is required" };
  }
  if (password.length < 8) {
    return { ok: false, errorText: "password must be at least 8 characters" };
  }
  try {
    await kernel.request("account.create", {
      kind: "human",
      username,
      password,
      gecos: String(args.gecos ?? "").trim() || undefined,
    });
    return { ok: true, errorText: "" };
  } catch (error) {
    return { ok: false, errorText: errorText(error) };
  }
}
