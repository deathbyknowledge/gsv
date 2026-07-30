import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterGatewayInterface,
  AdapterGatewayRequestFrame,
  AdapterOutboundMessage,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
} from "@humansandmachines/gsv/protocol";

type ImportRequest = {
  remoteUrl?: unknown;
  remoteRef?: unknown;
};

export type RecordedOutboundMessage = {
  accountId: string;
  message: AdapterOutboundMessage;
};

interface Env {
  GATEWAY: Fetcher & AdapterGatewayInterface;
  INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
}

export class IntegrationState extends DurableObject<Env> {
  async recordOutbound(entry: RecordedOutboundMessage): Promise<void> {
    const messages = await this.ctx.storage.get<RecordedOutboundMessage[]>("outbound") ?? [];
    messages.push(entry);
    await this.ctx.storage.put("outbound", messages);
  }

  async listOutbound(accountId?: string): Promise<RecordedOutboundMessage[]> {
    const messages = await this.ctx.storage.get<RecordedOutboundMessage[]>("outbound") ?? [];
    return accountId
      ? messages.filter((entry) => entry.accountId === accountId)
      : messages;
  }
}

export default class TestDependencies
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "test";

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__test/service-frame" && request.method === "POST") {
      const frame = await request.json<AdapterGatewayRequestFrame>();
      const response = await this.env.GATEWAY.serviceFrame(frame);
      return Response.json(response);
    }

    if (url.pathname === "/__test/outbound" && request.method === "GET") {
      const accountId = url.searchParams.get("accountId") ?? undefined;
      return Response.json(await this.integrationState().listOutbound(accountId));
    }

    if (url.pathname.endsWith("/read") && request.method === "GET") {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname.endsWith("/apply") && request.method === "POST") {
      const input = await request.json<Record<string, unknown>>();
      if (!Array.isArray(input.ops)) {
        return Response.json({ ok: false, error: "ops are required" }, { status: 400 });
      }
      return Response.json({ ok: true, head: "integration-head" });
    }

    if (url.pathname.endsWith("/import") && request.method === "POST") {
      const input = await request.json<ImportRequest>();
      return Response.json({
        ok: true,
        head: "integration-head",
        changed: true,
        remote_url: typeof input.remoteUrl === "string"
          ? input.remoteUrl
          : "https://example.invalid/gsv-manual",
        remote_ref: typeof input.remoteRef === "string" ? input.remoteRef : "main",
      });
    }

    await request.body?.cancel("Unhandled test dependency request").catch(() => {});
    return new Response(`Unhandled test dependency request: ${request.method} ${url.pathname}`, {
      status: 501,
    });
  }

  async adapterConnect(
    _accountId: string,
    _config?: Record<string, unknown>,
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }> {
    return {
      ok: true,
      connected: true,
      authenticated: true,
      message: "connected by integration fixture",
    };
  }

  async adapterDisconnect(_accountId: string): Promise<{ ok: true; message: string }> {
    return { ok: true, message: "disconnected by integration fixture" };
  }

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<{ ok: true; messageId: string }> {
    if (body && !body.stream.locked) {
      await body.stream.cancel("Integration fixture does not consume media").catch(() => {});
    }
    await this.integrationState().recordOutbound({ accountId, message });
    return { ok: true, messageId: `fixture:${message.deliveryId}` };
  }

  async adapterSetActivity(
    _accountId: string,
    _surface: AdapterSurface,
    _activity: AdapterActivity,
  ): Promise<{ ok: true }> {
    return { ok: true };
  }

  async adapterStatus(_accountId?: string): Promise<AdapterAccountStatus[]> {
    return [];
  }

  async run(
    _model: string,
    _input: unknown,
    _options?: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    return {};
  }

  async models(): Promise<never[]> {
    return [];
  }

  private integrationState(): DurableObjectStub<IntegrationState> {
    const id = this.env.INTEGRATION_STATE.idFromName("singleton");
    return this.env.INTEGRATION_STATE.get(id);
  }
}
