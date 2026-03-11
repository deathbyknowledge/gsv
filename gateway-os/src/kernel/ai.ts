/**
 * ai.* syscall handlers.
 *
 * ai.tools — returns available tool schemas + online devices accessible to caller.
 * ai.config — reads model/provider/apiKey from R2 config files.
 *
 * Config resolution order:
 *   /etc/gsv/config (system defaults) → ~/.config/gsv/config (user overrides)
 *
 * Config format (line-based key=value, like shell env files):
 *   provider=anthropic
 *   model=claude-sonnet-4-20250514
 *   api_key=sk-...
 *   reasoning=medium
 */

import type { KernelContext } from "./context";
import type { AiToolsResult, AiToolsDevice, AiConfigResult } from "../syscalls/ai";
import type { ToolDefinition, SyscallName } from "../syscalls";
import { intoSyscallTool, isRoutableSyscall } from "../syscalls";

import { FS_READ_DEFINITION } from "../syscalls/read";
import { FS_WRITE_DEFINITION } from "../syscalls/write";
import { FS_EDIT_DEFINITION } from "../syscalls/edit";
import { FS_WRITE_DEFINITION as FS_DELETE_DEFINITION } from "../syscalls/delete";
import { FS_SEARCH_DEFINITION } from "../syscalls/search";
import { SHELL_EXEC_DEFINITION } from "../syscalls/shell";

const SYSCALL_TOOLS: Record<string, ToolDefinition> = {
  "fs.read": FS_READ_DEFINITION,
  "fs.write": FS_WRITE_DEFINITION,
  "fs.edit": FS_EDIT_DEFINITION,
  "fs.delete": FS_DELETE_DEFINITION,
  "fs.search": FS_SEARCH_DEFINITION,
  "shell.exec": SHELL_EXEC_DEFINITION,
};

export async function handleAiTools(
  ctx: KernelContext,
): Promise<AiToolsResult> {
  const identity = ctx.identity!;
  const capabilities = identity.capabilities;
  const uid = identity.process.uid;
  const gids = identity.process.gids;

  const onlineDevices: AiToolsDevice[] = [];
  const deviceIds: string[] = [];

  for (const device of ctx.devices.listForUser(uid, gids)) {
    if (!device.online) continue;
    deviceIds.push(device.device_id);
    onlineDevices.push({
      id: device.device_id,
      implements: device.implements,
      platform: device.platform || undefined,
    });
  }

  const tools: ToolDefinition[] = [];

  for (const [syscall, baseDef] of Object.entries(SYSCALL_TOOLS)) {
    const allowed = capabilities.includes("*") || capabilities.some((cap) => {
      if (cap === syscall) return true;
      const domain = syscall.split(".")[0];
      return cap === `${domain}.*`;
    });
    if (!allowed) continue;

    if (isRoutableSyscall(syscall as SyscallName)) {
      tools.push(intoSyscallTool(baseDef, deviceIds));
    } else {
      tools.push(baseDef);
    }
  }

  return { tools, devices: onlineDevices };
}

export async function handleAiConfig(
  ctx: KernelContext,
): Promise<AiConfigResult> {
  const bucket = ctx.env.STORAGE;
  const home = ctx.identity?.process.home ?? "/root";

  const systemConfig = await readConfigFile(bucket, "/etc/gsv/config");
  const userConfig = await readConfigFile(bucket, `${home}/.config/gsv/config`);

  const merged = { ...systemConfig, ...userConfig };

  return {
    provider: merged.provider ?? "anthropic",
    model: merged.model ?? "claude-sonnet-4-20250514",
    apiKey: merged.api_key ?? "",
    reasoning: merged.reasoning,
  };
}

async function readConfigFile(
  bucket: R2Bucket,
  path: string,
): Promise<Record<string, string>> {
  const obj = await bucket.get(path);
  if (!obj) return {};

  const text = await obj.text();
  const config: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    config[key] = value;
  }

  return config;
}
