import type { InferenceExecutor as ExecutorContract, InferenceModelMetadata } from "@humansandmachines/gsv/services/inference-execution";
import { resolveModelContextWindowFromRegistry } from "../text/model-registry";
import { opaqueId, requireActiveInstallation, type ExecutorEnvironment } from "./config";
import * as z from "zod/mini";
import { isWorkersAiProvider, resolveWorkersAiModelContextWindow } from "../text/workers-ai";
import { RpcTarget, type DurableObject } from "cloudflare:workers";
import type { InferenceExecutor } from "./executor";

export type InferenceServiceEnvironment<Executor extends DurableObject<ExecutorEnvironment> = InferenceExecutor> = ExecutorEnvironment & {
  INFERENCE_EXECUTORS: DurableObjectNamespace<Executor>;
};

/** Resolve Accounts before addressing a name, so arbitrary IDs allocate no state. */
export async function getInferenceExecutor<Executor extends DurableObject<ExecutorEnvironment>>(env: InferenceServiceEnvironment<Executor>, id: string): Promise<ExecutorContract> {
  const installationId = opaqueId(id);
  await requireActiveInstallation(env, installationId);
  const stub: unknown = env.INFERENCE_EXECUTORS.getByName(installationId);
  // SAFETY: the exported executor implements this contract; avoid recursively expanding RPC mapped types.
  return new ExecutorTarget(stub as ExecutorContract);
}

export async function resolveInferenceModel(env: ExecutorEnvironment, provider: string, model: string): Promise<InferenceModelMetadata> {
  if (!z.string().check(z.maxLength(200)).safeParse(provider).success || !z.string().check(z.maxLength(500)).safeParse(model).success) throw new Error("Invalid inference model");
  const resolvedProvider = provider === "gsv" && model === "default" ? env.INFERENCE_DEFAULT_PROVIDER ?? provider : provider;
  const resolvedModel = provider === "gsv" && model === "default" ? env.INFERENCE_DEFAULT_MODEL ?? model : model;
  const contextWindowTokens = isWorkersAiProvider(resolvedProvider)
    ? await resolveWorkersAiModelContextWindow(resolvedModel, env.AI)
    : resolveModelContextWindowFromRegistry(resolvedProvider, resolvedModel);
  return { provider, model, contextWindowTokens };
}

/** The gateway receives execution authority; lifecycle RPCs remain private. */
class ExecutorTarget extends RpcTarget implements ExecutorContract {
  readonly #owner: ExecutorContract;
  constructor(owner: ExecutorContract) { super(); this.#owner = owner; }
  generate(...args: Parameters<ExecutorContract["generate"]>) { return this.#owner.generate(...args); }
  generateStream(...args: Parameters<ExecutorContract["generateStream"]>) { return this.#owner.generateStream(...args); }
  media(...args: Parameters<ExecutorContract["media"]>) { return this.#owner.media(...args); }
  abort(...args: Parameters<ExecutorContract["abort"]>) { return this.#owner.abort(...args); }
}
