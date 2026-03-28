import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { SqlExecArgs, SqlExecResult, SqlQueryArgs, SqlQueryResult } from "../syscalls/sql";
import { sendFrameToProcess } from "../shared/utils";
import type { KernelContext } from "./context";
import {
  auditSql,
  executeSqlExec,
  executeSqlQuery,
  prepareSqlExec,
  prepareSqlQuery,
  requireSqlRoot,
} from "../sql/runtime";

export async function handleSqlQuery(
  args: SqlQueryArgs,
  ctx: KernelContext,
): Promise<SqlQueryResult> {
  const uid = ctx.identity?.process.uid;
  requireSqlRoot(uid, "sql.query");

  const prepared = prepareSqlQuery(args);
  auditSql("Kernel", "sql.query", uid, prepared.target.raw, prepared.statement, prepared.bindings.length);

  if (prepared.target.kind === "kernel") {
    return executeSqlQuery(
      ctx.sql,
      prepared.target,
      prepared.statement,
      prepared.bindings,
    );
  }

  return forwardSqlToProcess<SqlQueryResult>(
    "sql.query",
    prepared.target.pid,
    {
      target: prepared.target.raw,
      statement: prepared.statement,
      ...(prepared.bindings.length > 0 ? { bindings: prepared.bindings } : {}),
    },
    ctx,
  );
}

export async function handleSqlExec(
  args: SqlExecArgs,
  ctx: KernelContext,
): Promise<SqlExecResult> {
  const uid = ctx.identity?.process.uid;
  requireSqlRoot(uid, "sql.exec");

  const prepared = prepareSqlExec(args);
  auditSql("Kernel", "sql.exec", uid, prepared.target.raw, prepared.statement, prepared.bindings.length);

  if (prepared.target.kind === "kernel") {
    return executeSqlExec(
      ctx.sql,
      prepared.target,
      prepared.statement,
      prepared.bindings,
    );
  }

  return forwardSqlToProcess<SqlExecResult>(
    "sql.exec",
    prepared.target.pid,
    {
      target: prepared.target.raw,
      statement: prepared.statement,
      ...(prepared.bindings.length > 0 ? { bindings: prepared.bindings } : {}),
    },
    ctx,
  );
}

async function forwardSqlToProcess<T>(
  call: "sql.query" | "sql.exec",
  pid: string,
  args: SqlQueryArgs | SqlExecArgs,
  ctx: KernelContext,
): Promise<T> {
  const proc = ctx.procs.get(pid);
  if (!proc) {
    throw new Error(`Process not found: ${pid}`);
  }

  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame);

  if (!response || response.type !== "res") {
    throw new Error(`No synchronous response for ${call}`);
  }

  const res = response as ResponseFrame;
  if (!res.ok) {
    throw new Error(res.error.message);
  }

  return res.data as T;
}
