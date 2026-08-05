import { WorkerEntrypoint } from "cloudflare:workers";

class BootstrapEntrypoint extends WorkerEntrypoint {
  async fetch(): Promise<Response> {
    return new Response("Managed GSV service is not deployed yet", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}

export default BootstrapEntrypoint;

// Clean-account bootstrap must create every service-binding target before any
// final Worker can be uploaded. Export the complete set of named entrypoints so
// Cloudflare can validate the final cyclic binding graph without exposing a
// partial implementation.
export class GatewayEntrypoint extends BootstrapEntrypoint {}
export class GatewayDirectoryEntrypoint extends BootstrapEntrypoint {}
export class EntitlementReaderEntrypoint extends BootstrapEntrypoint {}
export class InferenceService extends BootstrapEntrypoint {}
export class ManagedTelegramChannel extends BootstrapEntrypoint {}
