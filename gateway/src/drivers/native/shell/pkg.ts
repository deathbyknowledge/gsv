import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { AppRunnerCommandInput } from "../../../app-runner";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  handlePkgAdd,
  handlePkgCheckout,
  handlePkgCreate,
  handlePkgInstall,
  handlePkgList,
  handlePkgPublicList,
  handlePkgPublicSet,
  handlePkgRemoteAdd,
  handlePkgRemoteList,
  handlePkgRemoteRemove,
  handlePkgRemove,
  handlePkgReviewApprove,
  isRepoPublic,
  resolveInstalledPackage,
} from "../../../kernel/pkg";
import {
  packageAgentUsername,
  packageAgentAccessGroup,
} from "../../../kernel/package-agents";
import {
  packageRouteBase,
  visiblePackageScopesForActor,
  type InstalledPackageRecord,
  type PackageEntrypoint,
} from "../../../kernel/packages";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { requireCommandCapability } from "./common";

type PackageCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

type PackageRunnerStub = {
  ensureRuntime(input: {
    packageId: string;
    packageName: string;
    routeBase: string;
    entrypointName: string;
    artifact: InstalledPackageRecord["artifact"];
    appFrame: {
      uid: number;
      username: string;
      packageId: string;
      packageName: string;
      entrypointName: string;
      routeBase: string;
      issuedAt: number;
      expiresAt: number;
    };
  }): Promise<void>;
  runCommand(input: AppRunnerCommandInput): Promise<PackageCommandResult>;
};

export function buildPackageCommands(identity: ProcessIdentity, ctx: KernelContext) {
  const commands = [];
  const reserved = new Set([
    "pkg",
    "proc",
    "rgit",
    "ripgit",
    "sched",
    "mem",
    "notify",
    "whoami",
    "id",
    "hostname",
    "uname",
    "chown",
    "chmod",
    "ps",
    "man",
    "ls",
    "stat",
    "cp",
    "wiki",
    "skills",
    "codemode",
    "crontab",
    "mcp",
  ]);
  const packageRecords = ctx.packages.list({
    enabled: true,
    scopes: visiblePackageScopesForShellContext(ctx),
  });

  for (const record of packageRecords) {
    for (const entrypoint of record.manifest.entrypoints) {
      if (entrypoint.kind !== "command") continue;
      const commandName = entrypoint.command?.trim();
      if (!commandName || reserved.has(commandName)) continue;
      reserved.add(commandName);
      commands.push(buildPackageCommand(commandName, record, entrypoint, identity, ctx));
    }
  }

  return commands;
}

function buildPackageCommand(
  commandName: string,
  record: InstalledPackageRecord,
  entrypoint: PackageEntrypoint,
  identity: ProcessIdentity,
  ctx: KernelContext,
) {
  return defineCommand(commandName, async (args, bashCtx): Promise<ExecResult> => {
    try {
      const result = await runPackageCommand(record, entrypoint, args, bashCtx.cwd, identity, ctx);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `${commandName}: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

export function buildPkgCommand(ctx: KernelContext) {
  return defineCommand("pkg", async (args, bashCtx): Promise<ExecResult> => {
    try {
      return await runPkgCommand(args, ctx, bashCtx.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `pkg: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runPkgCommand(args: string[], ctx: KernelContext, _cwd: string): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: pkgUsage(), stderr: "", exitCode: 0 };
    case "list": {
      requireCommandCapability(ctx, "pkg.list");
      const result = handlePkgList({}, ctx);
      return { stdout: formatPkgList(result.packages), stderr: "", exitCode: 0 };
    }
    case "remotes": {
      requireCommandCapability(ctx, "pkg.remote.list");
      const result = handlePkgRemoteList({}, ctx);
      return { stdout: formatPkgRemotes(result.remotes), stderr: "", exitCode: 0 };
    }
    case "show":
    case "info":
    case "status": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx);
      return { stdout: formatPkgStatus(target, ctx), stderr: "", exitCode: 0 };
    }
    case "manifest": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx);
      return { stdout: `${JSON.stringify(target.manifest, null, 2)}\n`, stderr: "", exitCode: 0 };
    }
    case "capabilities": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx);
      return { stdout: formatPkgCapabilities(target), stderr: "", exitCode: 0 };
    }
    case "source": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx);
      return { stdout: formatPkgSource(target), stderr: "", exitCode: 0 };
    }
    case "add": {
      requireCommandCapability(ctx, "pkg.add");
      const result = await handlePkgAdd(parsePkgAddArgs(rest), ctx);
      return {
        stdout: `${result.package.enabled ? "imported and enabled" : "imported"} ${result.package.name} from ${result.imported.repo} (${result.imported.ref})\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "create": {
      requireCommandCapability(ctx, "pkg.create");
      const result = await handlePkgCreate(parsePkgCreateArgs(rest), ctx);
      return {
        stdout: `${result.created ? "created" : "updated"} ${result.package.name} in ${result.repo}:${result.subdir} (${result.ref})\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "remote": {
      const [remoteSubcommand, ...remoteArgs] = rest;
      if (!remoteSubcommand || remoteSubcommand === "list") {
        requireCommandCapability(ctx, "pkg.remote.list");
        const result = handlePkgRemoteList({}, ctx);
        return { stdout: formatPkgRemotes(result.remotes), stderr: "", exitCode: 0 };
      }
      if (remoteSubcommand === "add") {
        requireCommandCapability(ctx, "pkg.remote.add");
        const result = handlePkgRemoteAdd(parsePkgRemoteAddArgs(remoteArgs), ctx);
        return {
          stdout: `${result.changed ? "added" : "updated"} remote ${result.remote.name} -> ${result.remote.baseUrl}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (remoteSubcommand === "remove") {
        requireCommandCapability(ctx, "pkg.remote.remove");
        const name = String(remoteArgs[0] ?? "").trim();
        if (!name) {
          throw new Error("Usage: pkg remote remove <name>");
        }
        const result = handlePkgRemoteRemove({ name }, ctx);
        return {
          stdout: `${result.removed ? "removed" : "missing"} remote ${name}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unknown pkg remote subcommand: ${remoteSubcommand}`);
    }
    case "discover": {
      requireCommandCapability(ctx, "pkg.public.list");
      const result = await handlePkgPublicList({ remote: String(rest[0] ?? "").trim() || undefined }, ctx);
      return { stdout: formatPkgPublicCatalog(result), stderr: "", exitCode: 0 };
    }
    case "public": {
      const publicSubcommand = String(rest[0] ?? "").trim();
      if (!publicSubcommand || publicSubcommand === "list") {
        requireCommandCapability(ctx, "pkg.public.list");
        const result = await handlePkgPublicList({ remote: String(rest[1] ?? "").trim() || undefined }, ctx);
        return { stdout: formatPkgPublicCatalog(result), stderr: "", exitCode: 0 };
      }
      if (publicSubcommand === "on" || publicSubcommand === "off") {
        requireCommandCapability(ctx, "pkg.public.set");
        const result = handlePkgPublicSet({
          ...resolvePkgPublicTarget(rest[1], ctx),
          public: publicSubcommand === "on",
        }, ctx);
        return {
          stdout: `${result.public ? "published" : "hidden"} ${result.repo}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unknown pkg public subcommand: ${publicSubcommand}`);
    }
    case "approve": {
      requireCommandCapability(ctx, "pkg.review.approve");
      const target = resolvePkgTarget(rest[0], ctx);
      const result = handlePkgReviewApprove({ packageId: target.packageId }, ctx);
      return { stdout: `${result.changed ? "approved" : "already approved"} ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    case "enable": {
      requireCommandCapability(ctx, "pkg.install");
      const target = resolvePkgTarget(rest[0], ctx);
      const result = await handlePkgInstall({ packageId: target.packageId }, ctx);
      return { stdout: `${result.changed ? "enabled" : "already enabled"} ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    case "disable": {
      requireCommandCapability(ctx, "pkg.remove");
      const target = resolvePkgTarget(rest[0], ctx);
      const result = await handlePkgRemove({ packageId: target.packageId }, ctx);
      return { stdout: `${result.changed ? "disabled" : "already disabled"} ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    case "sync":
    case "update": {
      requireCommandCapability(ctx, "pkg.checkout");
      const parsed = parsePkgUpdateArgs(rest);
      const target = resolvePkgTarget(parsed.packageId, ctx);
      const ref = parsed.ref ?? target.manifest.source.ref;
      const result = await handlePkgCheckout({ packageId: target.packageId, ref }, ctx);
      return { stdout: `${result.changed ? "updated" : "already on"} ${ref} for ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    default:
      throw new Error(`Unknown pkg subcommand: ${subcommand}`);
  }
}

function resolvePkgTarget(rawPackageId: string | undefined, ctx: KernelContext): InstalledPackageRecord {
  const packageId = typeof rawPackageId === "string" ? rawPackageId.trim() : "";
  if (packageId) {
    return resolveInstalledPackage(packageId, ctx);
  }
  throw new Error("packageId is required");
}

function formatPkgList(packages: Array<{
  name: string;
  scope: { kind: "global" | "user"; uid?: number };
  enabled: boolean;
  review: { required: boolean; approvedAt: number | null };
  source: { repo: string; ref: string; public: boolean };
}>): string {
  const lines = ["NAME\tSCOPE\tSTATE\tREVIEW\tPUBLIC\tSOURCE\tREF"];
  for (const pkg of packages) {
    lines.push([
      pkg.name,
      formatPkgScope(pkg.scope),
      pkg.enabled ? "enabled" : "disabled",
      pkg.review.required && !pkg.review.approvedAt ? "pending" : (pkg.review.required ? "approved" : "n/a"),
      pkg.source.public ? "yes" : "no",
      pkg.source.repo,
      pkg.source.ref,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatPkgRemotes(remotes: { name: string; baseUrl: string }[]): string {
  const lines = ["NAME\tBASE URL"];
  for (const remote of remotes) {
    lines.push(`${remote.name}\t${remote.baseUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatPkgStatus(pkg: InstalledPackageRecord, ctx: KernelContext): string {
  const review = pkg.reviewRequired
    ? (pkg.reviewedAt ? `approved at ${new Date(pkg.reviewedAt).toISOString()}` : "approval required")
    : "not required";
  const isPublic = isRepoPublic(pkg.manifest.source.repo, ctx.config);
  const bindings = getPkgDeclaredBindings(pkg).map((binding) => binding.binding);
  const entrypoints = pkg.manifest.entrypoints.length > 0
    ? pkg.manifest.entrypoints.map((entry) => `${entry.name}:${entry.kind}`).join(", ")
    : "none";
  const profiles = (pkg.manifest.profiles ?? []).map((profile) => {
    const username = packageAgentUsername(pkg.manifest.name, profile.name);
    const provisioned = ctx.auth.getPasswdByUsername(username) ? "installed" : "not installed";
    const group = ctx.auth.getGroupByName(packageAgentAccessGroup(username));
    const access = group?.members.length ? `, access ${group.members.join(",")}` : "";
    return `${profile.name} (${pkg.manifest.name}#${profile.name} -> ${username}, ${provisioned}${access})`;
  });
  return [
    `package: ${pkg.manifest.name}`,
    `packageId: ${pkg.packageId}`,
    `scope: ${formatPkgScope(pkg.scope)}`,
    `enabled: ${pkg.enabled ? "yes" : "no"}`,
    `review: ${review}`,
    `public: ${isPublic ? "yes" : "no"}`,
    `source: ${pkg.manifest.source.repo}`,
    `ref: ${pkg.manifest.source.ref}`,
    `subdir: ${pkg.manifest.source.subdir}`,
    `resolvedCommit: ${pkg.manifest.source.resolvedCommit ?? "unknown"}`,
    `bindings: ${bindings.length > 0 ? bindings.join(", ") : "none"}`,
    `entrypoints: ${entrypoints}`,
    `profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
    "",
  ].join("\n");
}

function formatPkgCapabilities(pkg: InstalledPackageRecord): string {
  const declaredBindings = getPkgDeclaredBindings(pkg);
  const grantedBindings = pkg.grants?.bindings ?? [];
  const declaredEgress = pkg.manifest.capabilities?.egress;
  const grantedEgress = pkg.grants?.egress;
  const entrypointSyscalls = Array.from(new Set(pkg.manifest.entrypoints.flatMap((entry) => entry.syscalls ?? [])));
  const profileCapabilities = (pkg.manifest.profiles ?? [])
    .map((profile) => ({
      profile: profile.name,
      capabilities: [...new Set(profile.capabilities ?? [])].sort(),
    }))
    .filter((entry) => entry.capabilities.length > 0);
  return [
    `package: ${pkg.manifest.name}`,
    "declared bindings:",
    declaredBindings.length > 0
      ? declaredBindings.map((binding) =>
        `- ${binding.binding} (${binding.kind}, ${binding.interfaceName}, ${binding.required ? "required" : "optional"})`
      ).join("\n")
      : "none",
    "granted bindings:",
    grantedBindings.length > 0
      ? grantedBindings.map((binding) => `- ${binding.binding} -> ${binding.providerKind}:${binding.providerRef}`).join("\n")
      : "none",
    "declared egress:",
    formatPkgEgress(declaredEgress?.mode, declaredEgress?.allow),
    "granted egress:",
    formatPkgEgress(grantedEgress?.mode, grantedEgress?.allow),
    "entrypoint syscalls:",
    entrypointSyscalls.length > 0 ? `- ${entrypointSyscalls.join("\n- ")}` : "none",
    "profile capabilities:",
    profileCapabilities.length > 0
      ? profileCapabilities.map((entry) =>
        `- ${entry.profile}: ${entry.capabilities.join(", ")}`
      ).join("\n")
      : "none",
    "",
  ].join("\n");
}

function getPkgDeclaredBindings(pkg: InstalledPackageRecord) {
  return pkg.manifest.capabilities?.bindings ?? [];
}

function formatPkgEgress(mode?: string, allow?: string[]): string {
  if (!mode) return "none";
  if (mode !== "allowlist") return mode;
  return Array.isArray(allow) && allow.length > 0
    ? `allowlist (${allow.join(", ")})`
    : "allowlist";
}

function formatPkgSource(target: InstalledPackageRecord): string {
  const source = target.manifest.source;
  const subdir = source.subdir && source.subdir !== "." ? source.subdir : "";
  const path = `/src/repos/${source.repo}${subdir ? `/${subdir}` : ""}`;
  const lines = [
    `package: ${target.manifest.name}`,
    `packageId: ${target.packageId}`,
    `repo: ${source.repo}`,
    `ref: ${source.ref}`,
    `subdir: ${source.subdir}`,
    `commit: ${source.resolvedCommit ?? "-"}`,
    `path: ${path}`,
    "",
  ];
  return lines.join("\n");
}

function formatPkgPublicCatalog(result: Awaited<ReturnType<typeof handlePkgPublicList>>): string {
  const lines = [
    `source: ${result.serverName}`,
    `origin: ${result.source.kind === "remote" ? result.source.baseUrl ?? result.source.name : "local"}`,
    "",
    "NAME\tRUNTIME\tREPO\tREF\tSUBDIR",
  ];
  for (const entry of result.packages) {
    lines.push(`${entry.name}\t${entry.runtime}\t${entry.source.repo}\t${entry.source.ref}\t${entry.source.subdir}`);
  }
  lines.push("");
  return lines.join("\n");
}

function parsePkgAddArgs(args: string[]): {
  repo?: string;
  remoteUrl?: string;
  ref?: string;
  subdir?: string;
  enable?: boolean;
} {
  const parsed: {
    repo?: string;
    remoteUrl?: string;
    ref?: string;
    subdir?: string;
    enable?: boolean;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--repo") {
      parsed.repo = requirePkgValue(args, index, "Usage: pkg add --repo owner/repo [--ref main] [--subdir .] [--enable]");
      index += 1;
      continue;
    }
    if (current === "--remote-url" || current === "--url") {
      parsed.remoteUrl = requirePkgValue(args, index, "Usage: pkg add --remote-url https://... [--ref main] [--subdir .] [--enable]");
      index += 1;
      continue;
    }
    if (current === "--ref") {
      parsed.ref = requirePkgValue(args, index, "Usage: pkg add --repo owner/repo [--ref main] [--subdir .] [--enable]");
      index += 1;
      continue;
    }
    if (current === "--subdir") {
      parsed.subdir = requirePkgValue(args, index, "Usage: pkg add --repo owner/repo [--ref main] [--subdir .] [--enable]");
      index += 1;
      continue;
    }
    if (current === "--enable") {
      parsed.enable = true;
      continue;
    }
    throw new Error(`Unknown pkg add argument: ${current}`);
  }
  return parsed;
}

function parsePkgCreateArgs(args: string[]): {
  repo: string;
  name?: string;
  displayName?: string;
  description?: string;
  ref?: string;
  subdir?: string;
  template?: "web-ui" | "command";
  command?: string;
  overwrite?: boolean;
  enable?: boolean;
} {
  const parsed: {
    repo?: string;
    name?: string;
    displayName?: string;
    description?: string;
    ref?: string;
    subdir?: string;
    template?: "web-ui" | "command";
    command?: string;
    overwrite?: boolean;
    enable?: boolean;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--repo") {
      parsed.repo = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--name @owner/pkg]");
      index += 1;
      continue;
    }
    if (current === "--name") {
      parsed.name = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--name @owner/pkg]");
      index += 1;
      continue;
    }
    if (current === "--display-name") {
      parsed.displayName = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--name @owner/pkg]");
      index += 1;
      continue;
    }
    if (current === "--description") {
      parsed.description = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--name @owner/pkg]");
      index += 1;
      continue;
    }
    if (current === "--ref") {
      parsed.ref = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--name @owner/pkg]");
      index += 1;
      continue;
    }
    if (current === "--subdir") {
      parsed.subdir = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--name @owner/pkg]");
      index += 1;
      continue;
    }
    if (current === "--template") {
      const template = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--template web-ui|command]");
      if (template !== "web-ui" && template !== "command") {
        throw new Error("template must be web-ui or command");
      }
      parsed.template = template;
      index += 1;
      continue;
    }
    if (current === "--command") {
      parsed.command = requirePkgValue(args, index, "Usage: pkg create --repo owner/repo [--command name]");
      index += 1;
      continue;
    }
    if (current === "--overwrite") {
      parsed.overwrite = true;
      continue;
    }
    if (current === "--enable") {
      parsed.enable = true;
      continue;
    }
    throw new Error(`Unknown pkg create argument: ${current}`);
  }

  if (!parsed.repo) {
    throw new Error("Usage: pkg create --repo owner/repo [--name @owner/pkg]");
  }

  return {
    repo: parsed.repo,
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
    ...(parsed.template ? { template: parsed.template } : {}),
    ...(parsed.command ? { command: parsed.command } : {}),
    ...(typeof parsed.overwrite === "boolean" ? { overwrite: parsed.overwrite } : {}),
    ...(typeof parsed.enable === "boolean" ? { enable: parsed.enable } : {}),
  };
}

function parsePkgUpdateArgs(args: string[]): { packageId?: string; ref?: string } {
  const parsed: { packageId?: string; ref?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--ref") {
      parsed.ref = requirePkgValue(args, index, "Usage: pkg update <package> [--ref REF]");
      index += 1;
      continue;
    }
    if (!parsed.packageId) {
      parsed.packageId = current;
      continue;
    }
    throw new Error(`Unknown pkg update argument: ${current}`);
  }
  if (!parsed.packageId) {
    throw new Error("Usage: pkg update <package> [--ref REF]");
  }
  return parsed;
}

function requirePkgValue(args: string[], index: number, usage: string): string {
  const value = String(args[index + 1] ?? "").trim();
  if (!value || value.startsWith("-")) {
    throw new Error(usage);
  }
  return value;
}

function parsePkgRemoteAddArgs(args: string[]): { name: string; baseUrl: string } {
  const name = String(args[0] ?? "").trim();
  const baseUrl = String(args[1] ?? "").trim();
  if (!name || !baseUrl) {
    throw new Error("Usage: pkg remote add <name> <baseUrl>");
  }
  return { name, baseUrl };
}

function resolvePkgPublicTarget(
  rawTarget: string | undefined,
  ctx: KernelContext,
): { packageId?: string; repo?: string } {
  const target = String(rawTarget ?? "").trim();
  if (!target) {
    throw new Error("packageId or repo is required");
  }

  const found = ctx.packages.resolve(target, visiblePackageScopesForShellContext(ctx));
  if (found) {
    return { packageId: found.packageId };
  }

  if (target.includes("/")) {
    return { repo: target };
  }

  return { packageId: resolveInstalledPackage(target, ctx).packageId };
}

function visiblePackageScopesForShellContext(ctx: KernelContext) {
  if (!ctx.identity) {
    return visiblePackageScopesForActor(undefined);
  }
  return visiblePackageScopesForActor({ uid: resolveCallerOwnerUid(ctx) });
}

function formatPkgScope(scope: { kind: "global" | "user"; uid?: number }): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.uid ?? "?"}`;
    default:
      return "global";
  }
}

function pkgUsage(): string {
  return [
    "Usage: pkg <subcommand> [args]",
    "",
    "Read-only:",
    "  pkg list",
    "  pkg remotes",
    "  pkg discover [remote]",
    "  pkg show <package>",
    "  pkg info <package>",
    "  pkg manifest <package>",
    "  pkg capabilities <package>",
    "  pkg source <package>",
    "  pkg public list [remote]",
    "",
    "Mutating:",
    "  pkg add --repo owner/repo [--ref main] [--subdir .] [--enable]",
    "  pkg add --remote-url https://... [--ref main] [--subdir .] [--enable]",
    "  pkg create --repo owner/repo [--template web-ui|command] [--enable]",
    "  pkg remote add <name> <baseUrl>",
    "  pkg remote remove <name>",
    "  pkg public on [package|owner/repo]",
    "  pkg public off [package|owner/repo]",
    "  pkg approve <package>",
    "  pkg enable <package>",
    "  pkg disable <package>",
    "  pkg update <package> [--ref REF]",
    "  pkg sync <package> [--ref REF]",
    "",
    "Use rgit for repository refs, logs, diffs, commits, and staged /src/repos changes.",
    "",
  ].join("\n");
}

async function runPackageCommand(
  record: InstalledPackageRecord,
  entrypoint: PackageEntrypoint,
  args: string[],
  cwd: string,
  identity: ProcessIdentity,
  ctx: KernelContext,
): Promise<PackageCommandResult> {
  const commandName = entrypoint.command?.trim() || entrypoint.name;
  const routeBase = packageRouteBase(record.manifest.name);
  const runner = ctx.getAppRunner(identity.uid, record.packageId) as PackageRunnerStub;
  const now = Date.now();
  await runner.ensureRuntime({
    packageId: record.packageId,
    packageName: record.manifest.name,
    routeBase,
    entrypointName: commandName,
    artifact: record.artifact,
    appFrame: {
      uid: identity.uid,
      username: identity.username,
      packageId: record.packageId,
      packageName: record.manifest.name,
      entrypointName: commandName,
      routeBase,
      issuedAt: now,
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    },
  });

  return runner.runCommand({
    commandName,
    args,
    cwd,
    uid: identity.uid,
    gid: identity.gid,
    username: identity.username,
  });
}
