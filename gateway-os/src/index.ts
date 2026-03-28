import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  DynamicWorkerKernelBindingProps,
} from "./app-runtime/backend";
import type { ArgsOf, ResultOf, SyscallName } from "./syscalls";
import { isWebSocketRequest } from "./shared//utils";
import type {
  GatewayAdapterInterface,
} from "./adapter-interface";
import type { Frame } from "./protocol/frames";
import { getAgentByName } from "agents";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      return kernel.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Gateway Entrypoint for Service Binding RPC
 *
 * Adapter workers call these methods via Service Bindings.
 * This provides a secure, type-safe interface for adapters to deliver
 * inbound messages to the Gateway.
 */
export class GatewayEntrypoint
  extends WorkerEntrypoint<Env>
  implements GatewayAdapterInterface
{
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    try {
      const kernel = await getAgentByName(this.env.KERNEL, "singleton");
      return await kernel.serviceFrame(frame);
    } catch (e) {
      console.error("[GatewayEntrypoint] serviceFrame failed:", e);
      return null;
    }
  }
}

export class AppKernelBinding
  extends WorkerEntrypoint<Env, DynamicWorkerKernelBindingProps>
{
  async call<S extends SyscallName>(syscall: S, args: ArgsOf<S>): Promise<ResultOf<S>> {
    if (!this.ctx.props.allowedSyscalls.includes(syscall)) {
      throw new Error(`App backend binding denies syscall ${syscall}`);
    }

    return this.ctx.props.kernel.appBackendSyscall({
      session: this.ctx.props.session,
      syscall,
      args,
    });
  }
}
