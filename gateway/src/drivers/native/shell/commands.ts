import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { FsCopyDeviceTransport } from "../fs";
import { buildNotifyCommands } from "../notify-shell";
import { buildCodeModeCommand } from "./codemode";
import { buildCoreCommands } from "./core";
import { buildCpCommand } from "./cp";
import { buildLsCommand } from "./ls";
import { buildMcpCommand } from "./mcp";
import { buildPackageCommands, buildPkgCommand } from "./pkg";
import { buildProcCommand } from "./proc";
import { buildSchedCommand } from "./sched";
import { buildSkillsCommand } from "./skills";
import { buildStatCommand } from "./stat";

export type NativeShellCommandOptions = {
  fsCopyTransport?: FsCopyDeviceTransport;
};

export function buildCustomCommands(
  fs: GsvFs,
  identity: ProcessIdentity,
  ctx: KernelContext,
  options?: NativeShellCommandOptions,
) {
  const coreCommands = buildCoreCommands(fs, identity, ctx);
  const ls = buildLsCommand(fs, identity, ctx);
  const stat = buildStatCommand(fs, identity, ctx);
  const cp = buildCpCommand(ctx, options?.fsCopyTransport);
  const codemode = buildCodeModeCommand(fs, identity, ctx);
  const mcp = buildMcpCommand(ctx);
  const pkg = buildPkgCommand(ctx);
  const skills = buildSkillsCommand(fs, ctx, identity);
  const proc = buildProcCommand(ctx);
  const sched = buildSchedCommand(ctx);
  const notifyCommands = buildNotifyCommands(ctx);
  const packageCommands = buildPackageCommands(identity, ctx);
  const flynn = defineCommand("flynn", async (): Promise<ExecResult> => ({
    stdout: `General Systems Vehicle ${ctx.config.get("config/server/version") ?? "0.1.6"} - Steve James.\n\n"I kept dreaming of a world I thought I'd never see. And then, one day... I got in."`,
    stderr: "",
    exitCode: 0,
  }));

  return [
    ...coreCommands,
    ls,
    stat,
    cp,
    codemode,
    mcp,
    proc,
    sched,
    pkg,
    skills,
    flynn,
    ...notifyCommands,
    ...packageCommands,
  ];
}
