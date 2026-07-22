import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { NetFetchDeviceTransport } from "../../../kernel/net";
import type { RequestFrame, ResponseFrame } from "../../../protocol/frames";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { FsCopyDeviceTransport } from "../fs";
import { buildNotifyCommands } from "../notify-shell";
import { buildCodeModeCommand } from "./codemode";
import { buildCoreCommands } from "./core";
import { buildCpCommand } from "./cp";
import { buildCrontabCommand } from "./crontab";
import { buildLsCommand } from "./ls";
import { buildLlmCommand } from "./llm";
import { buildMediaCommands } from "./media";
import { buildMessageCommand } from "./message";
import { buildMcpCommand } from "./mcp";
import { buildNetCommands } from "./net";
import { buildOAuthCommand } from "./oauth";
import { buildPackageCommands, buildPkgCommand } from "./pkg";
import { buildProcCommand } from "./proc";
import { buildRgitCommands } from "./rgit";
import { buildSchedCommand } from "./sched";
import { buildSkillsCommand } from "./skills";
import { buildStatCommand } from "./stat";
import { buildTargetsCommands } from "./targets";
import { buildUserCommand } from "./user";
import { buildWikiCommand } from "./wiki";
import { ShellDiscoveryCatalog } from "./discovery";

export type NativeShellCommandOptions = {
  fsCopyTransport?: FsCopyDeviceTransport;
  netFetchTransport?: NetFetchDeviceTransport;
  request?: (
    frame: RequestFrame,
    signal?: AbortSignal,
  ) => Promise<ResponseFrame>;
};

export function buildCustomCommands(
  fs: GsvFs,
  identity: ProcessIdentity,
  ctx: KernelContext,
  options?: NativeShellCommandOptions,
) {
  const discovery = new ShellDiscoveryCatalog(fs, identity, ctx);
  const coreCommands = buildCoreCommands(fs, identity, ctx, discovery);
  const ls = buildLsCommand(fs, identity, ctx);
  const llm = buildLlmCommand(ctx, options?.netFetchTransport);
  const stat = buildStatCommand(fs, identity, ctx);
  const cp = buildCpCommand(ctx, options?.fsCopyTransport);
  const crontab = buildCrontabCommand(fs, ctx);
  const codemode = buildCodeModeCommand(fs, identity, ctx, options?.request);
  const mcp = buildMcpCommand(ctx);
  const pkg = buildPkgCommand(ctx);
  const skills = buildSkillsCommand(fs, ctx, identity);
  const wiki = buildWikiCommand(ctx);
  const proc = buildProcCommand(ctx);
  const rgitCommands = buildRgitCommands(ctx);
  const sched = buildSchedCommand(ctx);
  const targets = buildTargetsCommands(ctx);
  const mediaCommands = buildMediaCommands(fs, ctx);
  const message = buildMessageCommand(fs, ctx);
  const netCommands = buildNetCommands(ctx, options?.netFetchTransport);
  const oauth = buildOAuthCommand(ctx);
  const user = buildUserCommand(ctx, options?.request);
  const notifyCommands = buildNotifyCommands(ctx);
  const flynn = defineCommand("flynn", async (): Promise<ExecResult> => ({
    stdout: `General Systems Vehicle ${ctx.config.get("config/server/version") ?? "0.1.6"} - Steve James.\n\n"I kept dreaming of a world I thought I'd never see. And then, one day... I got in."`,
    stderr: "",
    exitCode: 0,
  }));

  const nativeCommands = [
    ...coreCommands,
    ls,
    stat,
    cp,
    crontab,
    codemode,
    mcp,
    proc,
    ...rgitCommands,
    sched,
    ...targets,
    ...netCommands,
    oauth,
    user,
    llm,
    ...mediaCommands,
    message,
    pkg,
    skills,
    wiki,
    flynn,
    ...notifyCommands,
  ];
  const packageCommands = buildPackageCommands(
    identity,
    ctx,
    new Set(nativeCommands.map((command) => command.name)),
  );
  const commands = [...nativeCommands, ...packageCommands];
  discovery.registerCommands(commands);
  return commands;
}
