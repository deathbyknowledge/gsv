import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterGatewayInterface,
  AdapterGatewayRequestFrame,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
  ManagedGatewayProvisioningInterface,
  ProvisionInstallationInput,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import { LEGACY_STANDALONE_INSTALLATION_ID } from "../../src/installation/identity";

type ImportRequest = {
  remoteUrl?: unknown;
  remoteRef?: unknown;
};

export type RecordedOutboundMessage = {
  installationId: string;
  accountId: string;
  message: AdapterOutboundMessage;
};

export type RecordedTelegramApiCall = {
  method: string;
  payload: Record<string, unknown>;
  messageId: number;
};

export type RecordedEmail = {
  to: unknown;
  subject: string;
};

interface Env {
  GATEWAY: Fetcher & AdapterGatewayInterface & ManagedGatewayProvisioningInterface;
  INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
  MANAGED_TELEGRAM?: AdapterWorkerInterface;
}

export class IntegrationState extends DurableObject<Env> {
  async recordOutbound(entry: RecordedOutboundMessage): Promise<void> {
    const messages = await this.ctx.storage.get<RecordedOutboundMessage[]>("outbound") ?? [];
    messages.push(entry);
    await this.ctx.storage.put("outbound", messages);
  }

  async listOutbound(
    installationId?: string,
    accountId?: string,
  ): Promise<RecordedOutboundMessage[]> {
    const messages = await this.ctx.storage.get<RecordedOutboundMessage[]>("outbound") ?? [];
    return messages.filter((entry) => (
      (!installationId || entry.installationId === installationId)
      && (!accountId || entry.accountId === accountId)
    ));
  }

  async rememberProvision(result: ProvisionInstallationResult): Promise<void> {
    await this.ctx.storage.put(`provision:${result.installationId}`, result);
  }

  async consumeHandoff(
    token: string,
    installationId: string,
  ): Promise<ProvisionInstallationResult | null> {
    return await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get<boolean>(`handoff:${token}`)) return null;
      const provision = await txn.get<ProvisionInstallationResult>(
        `provision:${installationId}`,
      );
      if (!provision) return null;
      await txn.put(`handoff:${token}`, true);
      return provision;
    });
  }

  async recordTelegramApiCall(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    return await this.ctx.storage.transaction(async (txn) => {
      const calls = await txn.get<RecordedTelegramApiCall[]>("telegram_api") ?? [];
      const messageId = calls.length + 1;
      calls.push({ method, payload, messageId });
      await txn.put("telegram_api", calls);
      return messageId;
    });
  }

  async listTelegramApiCalls(): Promise<RecordedTelegramApiCall[]> {
    return await this.ctx.storage.get<RecordedTelegramApiCall[]>("telegram_api") ?? [];
  }

  async recordDeletedRepository(path: string): Promise<void> {
    const repositories = await this.ctx.storage.get<string[]>("deleted_repositories") ?? [];
    repositories.push(path);
    await this.ctx.storage.put("deleted_repositories", repositories);
  }

  async listDeletedRepositories(): Promise<string[]> {
    return await this.ctx.storage.get<string[]>("deleted_repositories") ?? [];
  }

  async recordEmail(email: RecordedEmail): Promise<number> {
    const emails = await this.ctx.storage.get<RecordedEmail[]>("emails") ?? [];
    emails.push(email);
    await this.ctx.storage.put("emails", emails);
    return emails.length;
  }

  async listEmails(): Promise<RecordedEmail[]> {
    return await this.ctx.storage.get<RecordedEmail[]>("emails") ?? [];
  }
}

export class TestEmailService extends WorkerEntrypoint<Env> {
  async send(message: {
    to?: unknown;
    subject?: unknown;
  }): Promise<{ messageId: string }> {
    if (typeof message.subject !== "string") {
      throw Object.assign(new Error("email subject is required"), {
        code: "E_FIELD_MISSING",
      });
    }
    const sequence = await integrationState(this.env).recordEmail({
      to: message.to,
      subject: message.subject,
    });
    return { messageId: `integration-email-${sequence}` };
  }
}

export default class TestDependencies
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "test";

  async resolveHostname(hostname: string): Promise<
    | {
        found: true;
        installationId: string;
        handle: string;
        canonicalOrigin: string;
        state: string;
      }
    | { found: false }
  > {
    const handle = hostname.endsWith(".gsv.space")
      ? hostname.slice(0, -".gsv.space".length)
      : "";
    if (handle !== "first" && handle !== "second") {
      return { found: false };
    }
    return {
      found: true,
      installationId: `inst_integration_${handle}`,
      handle,
      canonicalOrigin: `https://${handle}.gsv.space`,
      state: "active",
    };
  }

  async verifyLoginHandoff(token: string, hostname: string): Promise<
    | { ok: true; installationId: string; principalId: string; localUid: number }
    | { ok: false }
  > {
    const handle = hostname.endsWith(".gsv.space")
      ? hostname.slice(0, -".gsv.space".length)
      : "";
    if (token !== `test-handoff:${handle}` || (handle !== "first" && handle !== "second")) {
      return { ok: false };
    }
    const installationId = `inst_integration_${handle}`;
    const provision = await this.integrationState().consumeHandoff(token, installationId);
    return provision ? {
      ok: true,
      installationId,
      principalId: provision.principalId,
      localUid: provision.localUid,
    } : { ok: false };
  }

  async authorizeInstallationOnboarding(): Promise<{ ok: false }> {
    return { ok: false };
  }

  async completeInstallationOnboarding(): Promise<never> {
    throw new Error("Installation onboarding is unavailable in this fixture");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && /^\/bot[^/]+\/[^/]+$/.test(url.pathname)) {
      const method = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      const payload = await request.json<Record<string, unknown>>();
      const messageId = await this.integrationState().recordTelegramApiCall(
        method,
        payload,
      );
      return Response.json({
        ok: true,
        result: method === "sendChatAction"
          ? true
          : {
              message_id: messageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: payload.chat_id, type: "private" },
            },
      });
    }

    if (url.pathname === "/__test/service-frame" && request.method === "POST") {
      const input = await request.json<{
        installation: AdapterInstallationContext;
        frame: AdapterGatewayRequestFrame;
      }>();
      const response = await this.env.GATEWAY.serviceFrame(
        input.installation,
        input.frame,
      );
      return Response.json(response);
    }

    if (url.pathname === "/__test/provision" && request.method === "POST") {
      const input = await request.json<ProvisionInstallationInput>();
      const result = await this.env.GATEWAY.provisionInstallation(input);
      await this.integrationState().rememberProvision(result);
      return Response.json(result);
    }

    if (url.pathname === "/__test/outbound" && request.method === "GET") {
      const installationId = url.searchParams.get("installationId") ?? undefined;
      const accountId = url.searchParams.get("accountId") ?? undefined;
      return Response.json(await this.integrationState().listOutbound(
        installationId,
        accountId,
      ));
    }

    if (url.pathname === "/__test/telegram-api" && request.method === "GET") {
      return Response.json(await this.integrationState().listTelegramApiCalls());
    }

    if (url.pathname === "/__test/deleted-repositories" && request.method === "GET") {
      return Response.json(await this.integrationState().listDeletedRepositories());
    }

    if (url.pathname === "/__test/emails" && request.method === "GET") {
      return Response.json(await this.integrationState().listEmails());
    }

    if (url.pathname === "/__test/telegram-send" && request.method === "POST") {
      if (!this.env.MANAGED_TELEGRAM) {
        return Response.json({ ok: false, error: "binding unavailable" }, {
          status: 503,
        });
      }
      const input = await request.json<{
        installationId: string;
        accountId: string;
        message: AdapterOutboundMessage;
      }>();
      return Response.json(await this.env.MANAGED_TELEGRAM.adapterSend(
        { installationId: input.installationId },
        input.accountId,
        input.message,
      ));
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

    if (request.method === "GET" && /^\/[^/]+\/[^/]+\/bundle$/.test(url.pathname)) {
      if (request.headers.get("x-ripgit-actor-name") !== "root") {
        return new Response("Forbidden", { status: 403 });
      }
      const bytes = new TextEncoder().encode([
        "# v2 git bundle",
        `${"1".repeat(40)} refs/heads/main`,
        "",
        `PACK integration fixture ${url.pathname}`,
      ].join("\n"));
      const splitAt = Math.floor(bytes.byteLength / 2);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, splitAt));
          controller.enqueue(bytes.slice(splitAt));
          controller.close();
        },
      }), {
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "application/x-git-bundle",
        },
      });
    }

    if (request.method === "DELETE" && /^\/[^/]+\/[^/]+$/.test(url.pathname)) {
      await this.integrationState().recordDeletedRepository(url.pathname);
      return Response.json({ ok: true });
    }

    await request.body?.cancel("Unhandled test dependency request").catch(() => {});
    return new Response(`Unhandled test dependency request: ${request.method} ${url.pathname}`, {
      status: 501,
    });
  }

  async adapterConnect(
    _installation: AdapterInstallationContext,
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

  async adapterDisconnect(
    _installation: AdapterInstallationContext,
    _accountId: string,
  ): Promise<{ ok: true; message: string }> {
    return { ok: true, message: "disconnected by integration fixture" };
  }

  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<{ ok: true; messageId: string }> {
    if (body && !body.stream.locked) {
      await body.stream.cancel("Integration fixture does not consume media").catch(() => {});
    }
    await this.integrationState().recordOutbound({
      installationId: installation.installationId,
      accountId,
      message,
    });
    return { ok: true, messageId: `fixture:${message.deliveryId}` };
  }

  async adapterSetActivity(
    _installation: AdapterInstallationContext,
    _accountId: string,
    _surface: AdapterSurface,
    _activity: AdapterActivity,
  ): Promise<{ ok: true }> {
    return { ok: true };
  }

  async adapterStatus(
    _installation: AdapterInstallationContext,
    _accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
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
    return integrationState(this.env);
  }
}

function integrationState(env: Env): DurableObjectStub<IntegrationState> {
  const id = env.INTEGRATION_STATE.idFromName(
    LEGACY_STANDALONE_INSTALLATION_ID,
  );
  return env.INTEGRATION_STATE.get(id);
}
