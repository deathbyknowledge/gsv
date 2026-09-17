import type { AiDecideArgs, AiDecideResult } from "@humansandmachines/gsv/protocol";
import { requirePrincipal, resolveCallerOwnerUid, type KernelContext } from "./context";
import { inferenceLogicalRequestId } from "../inference/provider";
import { executeDecision } from "../inference/decision-client";

export async function handleAiDecide(args: AiDecideArgs, ctx: KernelContext): Promise<AiDecideResult> {
  const principal = requirePrincipal(ctx);
  const ownerUid = resolveCallerOwnerUid(ctx);
  const ownerPrefix = `users/${ownerUid}/ai/decision`;
  const own = ["provider", "model", "api_key"].some((field) => ctx.config.getExplicit(`${ownerPrefix}/${field}`) !== null);
  const prefix = own ? ownerPrefix : "config/ai/decision";
  const provider = ctx.config.get(`${prefix}/provider`)?.trim() || "typesafe";
  if (provider !== "typesafe") throw new Error("Unsupported decision provider");
  const apiKey = ctx.config.get(`${prefix}/api_key`)?.trim() || "";
  const model = args.model?.trim() || ctx.config.get(`${prefix}/model`)?.trim() || "jev-latest";
  const timeoutMs = args.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Decision timeout must be between 1 and 60000 ms");
  const logicalRequestId = await inferenceLogicalRequestId([
    "decision", ctx.installationId, principal.account.uid, ctx.processId, ctx.processRunId,
    ctx.requestId ?? crypto.randomUUID(),
  ]);
  return executeDecision(ctx.env, {
    installationId: ctx.installationId, logicalRequestId, timeoutMs,
    actor: { localUid: principal.account.uid, processId: ctx.processId, runId: ctx.processRunId },
    workload: "kernel",
    connection: { provider, model, apiKey, useOperatorKey: !own && !apiKey },
    input: { state: args.state, questions: args.questions },
  }, ctx.requestSignal);
}
