import {
  type AppCommandExecutionRequest,
  type AppCommandExecutionResult,
  type AppBackendKernelDispatcher,
  type DynamicWorkerKernelBinding,
  type DynamicWorkerKernelBindingProps,
  type DynamicWorkerAppBackendProps,
  type DynamicWorkerCommandEntrypoint,
} from "../app-runtime/backend";
import { getBuiltinAppBackendWorkerCode } from "../app-runtime/builtin-backends";
import type { AppDynamicWorkerBackend, AppSession } from "../app-runtime/contracts";
import type { SyscallName } from "../syscalls";
import type { KernelContext } from "./context";

type DynamicWorkerEnv = Env & {
  APP_BACKENDS?: WorkerLoader;
};

type DynamicWorkerRuntimeExports = {
  AppKernelBinding: (options: {
    props: DynamicWorkerKernelBindingProps;
  }) => DynamicWorkerKernelBinding;
  Kernel: {
    get(id: DurableObjectId): unknown;
  };
};

export async function executeDynamicWorkerAppCommand(
  session: AppSession,
  command: AppCommandExecutionRequest["command"],
  ctx: KernelContext,
): Promise<AppCommandExecutionResult> {
  if (session.backend.kind !== "dynamic-worker") {
    return {
      stdout: "",
      stderr: `${command.binaryName}: app package has no dynamic-worker backend\n`,
      exitCode: 1,
    };
  }

  const loader = getDynamicWorkerLoader(ctx.env);
  if (!loader) {
    return {
      stdout: "",
      stderr: `${command.binaryName}: app backend loader APP_BACKENDS is not configured\n`,
      exitCode: 1,
    };
  }

  const code = getBuiltinAppBackendWorkerCode(
    session.backend.workerName,
    session.backend.network,
  );
  if (!code) {
    return {
      stdout: "",
      stderr: `${command.binaryName}: no built-in backend is registered for ${session.backend.workerName}\n`,
      exitCode: 1,
    };
  }

  try {
    const worker = loader.get(
      computeDynamicWorkerCacheName(session.backend),
      () => ({
        ...code,
        env: {
          ...(code.env ?? {}),
          ...materializeDynamicWorkerEnv(session, ctx),
        },
      }),
    );
    const entrypoint = worker.getEntrypoint(
      session.backend.entrypoint,
      {
        props: {
          session,
        } satisfies DynamicWorkerAppBackendProps,
      },
    ) as unknown as DynamicWorkerCommandEntrypoint;

    return await entrypoint.execCommand({
      command,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `${command.binaryName}: dynamic-worker backend failed: ${message}\n`,
      exitCode: 1,
    };
  }
}

function computeDynamicWorkerCacheName(backend: AppDynamicWorkerBackend): string {
  return `${backend.workerName}@${backend.instanceKey}`;
}

function getDynamicWorkerLoader(env: Env): WorkerLoader | null {
  const loader = (env as DynamicWorkerEnv).APP_BACKENDS;
  return loader ?? null;
}

function materializeDynamicWorkerEnv(
  session: AppSession,
  ctx: KernelContext,
): Record<string, unknown> {
  if (session.backend.kind !== "dynamic-worker") {
    return {};
  }

  const kernelSyscalls = session.backend.bindings
    .flatMap((binding) => binding.kind === "kernel" ? binding.syscalls : [])
    .filter((syscall, index, values) => values.indexOf(syscall) === index) as SyscallName[];
  if (kernelSyscalls.length === 0) {
    return {};
  }

  if (!ctx.runtime) {
    throw new Error("Dynamic Worker kernel bindings require kernel runtime exports");
  }

  const runtimeExports = ctx.runtime.exports as unknown as DynamicWorkerRuntimeExports;
  const kernel = runtimeExports.Kernel.get(ctx.runtime.kernelId) as AppBackendKernelDispatcher;

  return {
    KERNEL: runtimeExports.AppKernelBinding({
      props: {
        session,
        allowedSyscalls: kernelSyscalls,
        kernel,
      },
    }),
  };
}
