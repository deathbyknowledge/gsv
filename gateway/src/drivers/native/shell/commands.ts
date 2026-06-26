import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { FsCopyDeviceTransport } from "../fs";
import { buildNotifyCommands } from "../notify-shell";
import { buildCodeModeCommand } from "./codemode";
import { buildCoreCommands } from "./core";
import { buildCpCommand } from "./cp";
import { buildCrontabCommand } from "./crontab";
import { buildLsCommand } from "./ls";
import { buildMediaCommands } from "./media";
import { buildMcpCommand } from "./mcp";
import { buildPackageCommands, buildPkgCommand } from "./pkg";
import { buildProcCommand } from "./proc";
import { buildRgitCommands } from "./rgit";
import { buildSchedCommand } from "./sched";
import { buildSkillsCommand } from "./skills";
import { buildStatCommand } from "./stat";
import { buildTargetsCommands } from "./targets";

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
  const crontab = buildCrontabCommand(fs, ctx);
  const codemode = buildCodeModeCommand(fs, identity, ctx);
  const mcp = buildMcpCommand(ctx);
  const pkg = buildPkgCommand(ctx);
  const skills = buildSkillsCommand(fs, ctx, identity);
  const proc = buildProcCommand(ctx);
  const rgitCommands = buildRgitCommands(ctx);
  const sched = buildSchedCommand(ctx);
  const targets = buildTargetsCommands(ctx);
  const mediaCommands = buildMediaCommands(fs, ctx);
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
    crontab,
    codemode,
    mcp,
    proc,
    ...rgitCommands,
    sched,
    ...targets,
    ...mediaCommands,
    pkg,
    skills,
    flynn,
    ...notifyCommands,
    ...packageCommands,
  ];
}
