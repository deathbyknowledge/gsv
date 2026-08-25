import type {
  ConnectionIdentity,
  ProcessIdentity,
  ScheduleExpression,
  SchedulePrincipal,
} from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import type { KernelContext, RunnableAccount } from "./context";
import { resolveCallerOwnerUid } from "./context";
import {
  armSchedule,
  normalizeScheduleExpression,
} from "./scheduler";

const USER_CRON_PREFIX = "/var/spool/cron/";
const SYSTEM_CRON_PREFIX = "/etc/cron.d/";

type CronJobSpec = {
  lineNumber: number;
  account: RunnableAccount;
  expression: Extract<ScheduleExpression, { kind: "cron" }>;
  command: string;
};

export type CronFileService = {
  listUserCrontabs(): Promise<string[]>;
  readUserCrontab(username: string): Promise<string | undefined>;
  installUserCrontab(username: string, content: string): Promise<void>;
  removeUserCrontab(username: string): Promise<boolean>;
  listSystemCrontabs(): Promise<string[]>;
  readSystemCrontab(name: string): Promise<string | undefined>;
  installSystemCrontab(name: string, content: string): Promise<void>;
  removeSystemCrontab(name: string): Promise<boolean>;
};

export function createCronFileService(ctx: KernelContext): CronFileService {
  return {
    listUserCrontabs() {
      return listUserCrontabs(ctx);
    },
    readUserCrontab(username: string) {
      return readUserCrontab(ctx, username);
    },
    installUserCrontab(username: string, content: string) {
      return installUserCrontab(ctx, username, content);
    },
    removeUserCrontab(username: string) {
      return removeUserCrontab(ctx, username);
    },
    listSystemCrontabs() {
      return listSystemCrontabs(ctx);
    },
    readSystemCrontab(name: string) {
      return readSystemCrontab(ctx, name);
    },
    installSystemCrontab(name: string, content: string) {
      return installSystemCrontab(ctx, name, content);
    },
    removeSystemCrontab(name: string) {
      return removeSystemCrontab(ctx, name);
    },
  };
}

async function listUserCrontabs(ctx: KernelContext): Promise<string[]> {
  const store = ctx.schedules;
  const actor = requireActor(ctx).process;
  const visibleAccounts = await ctx.listRunnableAccounts({
    ownerUid: resolveCallerOwnerUid(ctx),
    callerUid: actor.uid,
  });
  const visibleUsernames = new Set(
    visibleAccounts.map((account) => account.identity.username),
  );
  return store.listCronFiles({ prefix: USER_CRON_PREFIX })
    .map((record) => record.path.slice(USER_CRON_PREFIX.length))
    .filter((username) => username && visibleUsernames.has(username))
    .sort();
}

async function readUserCrontab(ctx: KernelContext, username: string): Promise<string | undefined> {
  const account = await requireRunnableAccount(ctx, username);
  return ctx.schedules.getCronFile(userCronPath(account.identity.username))?.content;
}

async function installUserCrontab(ctx: KernelContext, username: string, content: string): Promise<void> {
  const account = await requireRunnableAccount(ctx, username);
  const normalized = normalizeCronFileContent(content);
  const jobs = await parseUserCrontab(ctx, normalized, account);
  await replaceCronFile(ctx, {
    path: userCronPath(account.identity.username),
    ownerUid: account.identity.uid,
    content: normalized,
    jobs,
  });
}

async function removeUserCrontab(ctx: KernelContext, username: string): Promise<boolean> {
  const account = await requireRunnableAccount(ctx, username);
  return removeCronFile(ctx, userCronPath(account.identity.username));
}

async function listSystemCrontabs(ctx: KernelContext): Promise<string[]> {
  assertRoot(ctx, "list system crontabs");
  return ctx.schedules.listCronFiles({ prefix: SYSTEM_CRON_PREFIX, ownerUid: null })
    .map((record) => record.path.slice(SYSTEM_CRON_PREFIX.length))
    .filter(Boolean)
    .sort();
}

async function readSystemCrontab(ctx: KernelContext, name: string): Promise<string | undefined> {
  assertRoot(ctx, "read system crontabs");
  return ctx.schedules.getCronFile(systemCronPath(name))?.content;
}

async function installSystemCrontab(ctx: KernelContext, name: string, content: string): Promise<void> {
  assertRoot(ctx, "install system crontabs");
  const normalized = normalizeCronFileContent(content);
  const jobs = await parseSystemCrontab(ctx, normalized);
  await replaceCronFile(ctx, {
    path: systemCronPath(name),
    ownerUid: null,
    content: normalized,
    jobs,
  });
}

async function removeSystemCrontab(ctx: KernelContext, name: string): Promise<boolean> {
  assertRoot(ctx, "remove system crontabs");
  return removeCronFile(ctx, systemCronPath(name));
}

async function replaceCronFile(
  ctx: KernelContext,
  input: {
    path: string;
    ownerUid: number | null;
    content: string;
    jobs: CronJobSpec[];
  },
): Promise<void> {
  const store = ctx.schedules;
  const now = Date.now();
  for (const job of input.jobs) {
    if (!hasCapability(job.account.capabilities, "shell.exec")) {
      throw new Error(
        `Permission denied: ${job.account.identity.username} cannot run shell.exec`,
      );
    }
  }

  await removeLinkedSchedules(ctx, input.path);
  store.upsertCronFile({
    path: input.path,
    ownerUid: input.ownerUid,
    content: input.content,
    now,
  });

  for (const job of input.jobs) {
    const process = job.account.identity;
    const ownerUid = input.ownerUid === null
      ? process.uid
      : scheduleOwnerUidForUserCrontab(ctx, process);
    const packageSecurityRevision = job.account.packageSecurityRevision;
    const schedule = store.create({
      ownerUid,
      creator: principalFromIdentity(requireActor(ctx), ctx.processId),
      runAs: principalFromProcess(process),
      ...(packageSecurityRevision ? { packageSecurityRevision } : {}),
      name: `cron ${input.path}:${job.lineNumber}`,
      description: `Installed from ${input.path}:${job.lineNumber}`,
      enabled: true,
      expression: job.expression,
      target: {
        kind: "command.exec",
        command: job.command,
      },
      now,
    });
    store.linkCronFileSchedule(input.path, schedule.id);
    await armSchedule(ctx, schedule);
  }
}

async function removeCronFile(ctx: KernelContext, path: string): Promise<boolean> {
  const store = ctx.schedules;
  const existing = store.getCronFile(path);
  const linked = store.cronFileScheduleIds(path);
  await removeLinkedSchedules(ctx, path);
  const removed = store.removeCronFile(path);
  return existing !== null || removed !== null || linked.length > 0;
}

async function removeLinkedSchedules(ctx: KernelContext, path: string): Promise<void> {
  const store = ctx.schedules;
  const ids = store.cronFileScheduleIds(path);
  for (const id of ids) {
    const existing = store.getStored(id);
    if (existing?.wakeScheduleId) {
      await ctx.cancelScheduleWake(existing.wakeScheduleId);
    }
    store.remove(id);
  }
  store.clearCronFileScheduleLinks(path);
}

async function parseUserCrontab(
  ctx: KernelContext,
  content: string,
  account: RunnableAccount,
): Promise<CronJobSpec[]> {
  return parseCrontabLines(ctx, content, (line, lineNumber, timezone) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      throw new Error(`invalid crontab line ${lineNumber}: expected five schedule fields and a command`);
    }
    return cronJobFromParts(ctx, {
      lineNumber,
      timezone,
      account,
      fields: match.slice(1, 6),
      command: match[6],
    });
  });
}

async function parseSystemCrontab(ctx: KernelContext, content: string): Promise<CronJobSpec[]> {
  return parseCrontabLines(ctx, content, async (line, lineNumber, timezone) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      throw new Error(`invalid crontab line ${lineNumber}: expected five schedule fields, user, and command`);
    }
    const account = await requireRunnableAccount(ctx, match[6]);
    return cronJobFromParts(ctx, {
      lineNumber,
      timezone,
      account,
      fields: match.slice(1, 6),
      command: match[7],
    });
  });
}

async function parseCrontabLines(
  ctx: KernelContext,
  content: string,
  parseJob: (
    line: string,
    lineNumber: number,
    timezone: string,
  ) => CronJobSpec | Promise<CronJobSpec>,
): Promise<CronJobSpec[]> {
  const jobs: CronJobSpec[] = [];
  let timezone = await ctx.configGet("config/server/timezone") || "UTC";
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const env = parseCrontabEnv(trimmed);
    if (env) {
      if (env.name === "CRON_TZ" || env.name === "TZ") {
        timezone = validateTimezone(env.value, lineNumber);
      }
      continue;
    }

    jobs.push(await parseJob(trimmed, lineNumber, timezone));
  }
  return jobs;
}

function cronJobFromParts(
  ctx: KernelContext,
  input: {
    lineNumber: number;
    timezone: string;
    account: RunnableAccount;
    fields: string[];
    command: string;
  },
): CronJobSpec {
  const command = input.command.trim();
  if (!command) {
    throw new Error(`invalid crontab line ${input.lineNumber}: command is required`);
  }
  const expression = normalizeScheduleExpression({
    kind: "cron",
    expr: input.fields.join(" "),
    timezone: input.timezone,
  }, ctx) as Extract<ScheduleExpression, { kind: "cron" }>;
  return {
    lineNumber: input.lineNumber,
    account: input.account,
    expression,
    command,
  };
}

function parseCrontabEnv(line: string): { name: string; value: string } | null {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  return { name: match[1], value: match[2].trim() };
}

function validateTimezone(timezone: string, lineNumber: number): string {
  try {
    normalizeScheduleExpression({ kind: "cron", expr: "* * * * *", timezone });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid crontab line ${lineNumber}: ${message}`);
  }
  return timezone;
}

function normalizeCronFileContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.length === 0 || normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function userCronPath(username: string): string {
  return `${USER_CRON_PREFIX}${cronPathSegment(username)}`;
}

function systemCronPath(name: string): string {
  return `${SYSTEM_CRON_PREFIX}${cronPathSegment(name)}`;
}

function cronPathSegment(value: string): string {
  const segment = value.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) {
    throw new Error(`invalid cron file name: ${value}`);
  }
  return segment;
}

function requireActor(ctx: KernelContext): ConnectionIdentity {
  if (!ctx.identity) {
    throw new Error("identity is required");
  }
  return ctx.identity;
}

async function requireRunnableAccount(
  ctx: KernelContext,
  username: string,
): Promise<RunnableAccount> {
  const actor = requireActor(ctx).process;
  const resolved = await ctx.resolveRunAsAccount({
    ownerUid: resolveCallerOwnerUid(ctx),
    callerUid: actor.uid,
    selector: cronPathSegment(username),
  });
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }
  return resolved.account;
}

function assertRoot(ctx: KernelContext, action: string): void {
  if (requireActor(ctx).process.uid !== 0) {
    throw new Error(`Permission denied: cannot ${action}`);
  }
}

function scheduleOwnerUidForUserCrontab(
  ctx: KernelContext,
  user: ProcessIdentity,
): number {
  const actorUid = requireActor(ctx).process.uid;
  if (actorUid === 0) {
    return user.uid;
  }
  return resolveCallerOwnerUid(ctx);
}

function principalFromIdentity(identity: ConnectionIdentity, processId?: string): SchedulePrincipal {
  if (processId) {
    return {
      kind: "process",
      uid: identity.process.uid,
      username: identity.process.username,
      pid: processId,
    };
  }
  if (identity.role === "service") {
    return {
      kind: "service",
      uid: identity.process.uid,
      username: identity.process.username,
      channel: identity.channel,
    };
  }
  return {
    kind: "user",
    uid: identity.process.uid,
    username: identity.process.username,
  };
}

function principalFromProcess(process: ProcessIdentity): SchedulePrincipal {
  return {
    kind: "user",
    uid: process.uid,
    username: process.username,
  };
}
