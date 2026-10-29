import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationPhone, PhoneService } from "@humansandmachines/gsv/services/phone";
import type { Environment } from "./config";
import { callObjectName } from "./call";
import { sayTwiml, verifyTwilioSignature } from "./twilio";
export { CallCoordinator } from "./coordinator";
export { PhoneCallObject } from "./call";

const CALL_ID = /^[0-9a-f]{32}$/;
const INBOUND_MESSAGE = "This number places calls for Ship assistants and cannot take calls. Goodbye.";
const xml = (body: string) => new Response(body, { headers: { "Content-Type": "text/xml" } });

export default class CallsService extends WorkerEntrypoint<Environment> implements PhoneService {
  async getInstallation(installationId: string): Promise<InstallationPhone> {
    if (!installationId || installationId.length > 160) throw new Error("Invalid installation identity");
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!route.found) throw new Error("Unknown installation");
    // Restricted spaces can still follow and end calls already in progress; only new calls require an active space.
    return this.env.CALL_COORDINATORS.getByName(installationId).getTarget();
  }

  /** Twilio callbacks. Every request except the media stream carries Twilio's signature. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/twilio/stream/")) {
      // The stream proves itself with the per-call token in its start message.
      const [installationId = "", callId = ""] = url.pathname.slice("/twilio/stream/".length).split("/").map(decodeURIComponent);
      const call = this.#callFor(installationId, callId);
      return call ? call.fetch(request) : new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST" || !url.pathname.startsWith("/twilio/")) return new Response("Not Found", { status: 404 });
    const params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
    // Twilio signs the public URL it called, which a proxy in front of the Worker may rewrite.
    const signedUrl = new URL(url.pathname + url.search, this.env.PUBLIC_ORIGIN).href;
    if (!await verifyTwilioSignature(this.env.TWILIO_AUTH_TOKEN, signedUrl, params, request.headers.get("X-Twilio-Signature"))) {
      return new Response("Forbidden", { status: 403 });
    }
    const fields = Object.fromEntries(params);
    switch (url.pathname) {
      case "/twilio/status": await this.#call(url)?.providerStatus(fields); return new Response(null, { status: 204 });
      case "/twilio/machine": await this.#call(url)?.machineResult(fields); return new Response(null, { status: 204 });
      case "/twilio/join": {
        const identity = fields.From?.startsWith("client:") ? fields.From.slice("client:".length) : "";
        const installationId = fields.installation ?? "", callId = fields.call ?? "";
        if (!identity || !installationId || installationId.length > 160 || !CALL_ID.test(callId)) return xml("<Response><Hangup/></Response>");
        try {
          return xml(await this.env.CALLS.getByName(callObjectName(installationId, callId)).joinConnected(identity));
        } catch {
          return xml("<Response><Hangup/></Response>");
        }
      }
      case "/twilio/inbound": return xml(sayTwiml(INBOUND_MESSAGE));
      default: return new Response("Not Found", { status: 404 });
    }
  }

  #call(url: URL) {
    return this.#callFor(url.searchParams.get("i") ?? "", url.searchParams.get("c") ?? "");
  }

  #callFor(installationId: string, callId: string) {
    if (!installationId || installationId.length > 160 || !CALL_ID.test(callId)) return undefined;
    return this.env.CALLS.getByName(callObjectName(installationId, callId));
  }
}
