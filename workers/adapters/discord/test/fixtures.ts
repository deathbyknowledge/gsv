export const discordProviderFixture = String.raw`
import { DurableObject } from "cloudflare:workers";
export class Provider extends DurableObject {
  sockets = [];
  sent = [];
  received = [];
  sequence = 0;
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/reset") { this.sent = []; this.received = []; return new Response(null, { status: 204 }); }
    if (url.pathname === "/api/v10/gateway") return Response.json({ url: "wss://discord.fixture/gateway" });
    if (url.pathname === "/gateway") {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      this.sockets.push(server);
      server.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data);
        this.received.push({ op: frame.op, intents: frame.d?.intents, seq: frame.d?.seq, tokenCorrect: frame.d?.token === "synthetic-test-token" });
        if (frame.op === 2) server.send(JSON.stringify({ op: 0, t: "READY", s: ++this.sequence, d: { session_id: "fixture-session", application: { id: "1000" }, resume_gateway_url: "wss://discord.fixture/gateway", user: { id: "1000", username: "GSV fixture" } } }));
        if (frame.op === 6) server.send(JSON.stringify({ op: 0, t: "RESUMED", s: ++this.sequence, d: {} }));
        if (frame.op === 1) server.send(JSON.stringify({ op: 11, d: null }));
      });
      server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/dispatch") {
      const frame = await request.json();
      this.sockets.at(-1).send(JSON.stringify({ op: 0, s: ++this.sequence, ...frame }));
      return Response.json({ sequence: this.sequence });
    }
    if (url.pathname === "/received") return Response.json(this.received);
    if (url.pathname === "/sent") return Response.json(this.sent);
    if (url.pathname === "/api/v10/users/@me/channels") {
      const body = await request.json();
      return Response.json({ id: "8" + body.recipient_id });
    }
    if (/^\/api\/v10\/channels\/[0-9]+\/messages$/.test(url.pathname)) {
      const body = request.headers.get("Content-Type")?.includes("multipart")
        ? JSON.parse((await request.formData()).get("payload_json")) : await request.json();
      const prior = this.sent.find((row) => row.body.nonce === body.nonce);
      if (prior) return Response.json({ id: prior.id });
      const row = { id: String(900000 + this.sent.length), channel: url.pathname.split("/")[4], body };
      this.sent.push(row);
      return Response.json({ id: row.id });
    }
    if (url.pathname === "/media") return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    return new Response("Not found", { status: 404 });
  }
}
export default { async fetch(request, env) { return await env.PROVIDER.getByName("operator").fetch(request); } };`;

export const discordGatewayFixture = String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";
const calls = [];
export class AdapterGatewayEntrypoint extends WorkerEntrypoint {
  async resolveInstallation(installationId) { if (installationId === "singleton" || installationId.startsWith("missing-")) return { found: false }; return { found: true, installationId, state: installationId.startsWith("retired-") ? "retained" : "active", handle: installationId, canonicalOrigin: "https://" + installationId + ".gsv.test" }; }
  async serviceFrame(installation, frame) {
    const bytes = frame.body ? Array.from(new Uint8Array(await new Response(frame.body.stream).arrayBuffer())) : undefined;
    calls.push({ installation, call: frame.call, args: frame.args, bytes });
    return { type: "res", id: frame.id, ok: true, data: { ok: true, reply: { deliveryId: "reply:" + frame.args.deliveryId, text: "Fixture reply", replyToId: frame.args.message?.messageId } } };
  }
  async unlinkManagedAdapterIdentity(installation, input) { calls.push({ installation, call: "unlink", input }); return { removed: true }; }
  async fetch(request) { if (request.method === "DELETE") calls.length = 0; return Response.json(calls); }
}`;
