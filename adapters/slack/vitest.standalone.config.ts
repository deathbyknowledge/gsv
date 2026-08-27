import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        workers: [
          {
            name: "slack-gateway-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              const calls = [];
              export class AdapterGatewayEntrypoint extends WorkerEntrypoint {
                async serviceFrame(first, second) {
                  const installation = second ? first : { installationId: "singleton" };
                  const frame = second || first;
                  calls.push({ installation, call: frame.call, args: frame.args });
                  const data = frame.call === "adapter.inbound"
                    ? {
                        ok: true,
                        reply: {
                          deliveryId: "gateway-reply:" + frame.args.deliveryId,
                          text: "Standalone reply",
                          replyToId: frame.args.message.messageId,
                        },
                      }
                    : { ok: true };
                  return { type: "res", id: frame.id, ok: true, data };
                }
                async fetch() {
                  return Response.json(calls);
                }
              }
            `,
          },
          {
            name: "slack-api-test",
            modules: true,
            script: `
              const calls = [];
              let nextTs = 1700001000;
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/calls") {
                    return Response.json(calls);
                  }
                  const method = url.pathname.split("/").at(-1);
                  const body = await request.json();
                  calls.push({ method, body });
                  if (method === "auth.test") {
                    return Response.json({
                      ok: true,
                      team_id: "TWORK123",
                      team: "Acme",
                      user_id: "UGSVBOT1",
                    });
                  }
                  if (method === "apps.connections.open") {
                    return Response.json({
                      ok: true,
                      url: "wss://wss-primary.slack.com/link/?ticket=test",
                    });
                  }
                  if (method === "chat.postMessage") {
                    nextTs += 1;
                    return Response.json({
                      ok: true,
                      channel: body.channel,
                      ts: String(nextTs) + ".000100",
                    });
                  }
                  return Response.json({ ok: false, error: "unknown_method" });
                },
              };
            `,
          },
          {
            name: "slack-socket-test",
            modules: true,
            durableObjects: {
              SOCKET_SERVER: {
                className: "SlackSocketServer",
                useSQLite: true,
              },
            },
            script: `
              import { DurableObject } from "cloudflare:workers";
              export class SlackSocketServer extends DurableObject {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/state") {
                    return Response.json({
                      acknowledgements: await this.ctx.storage.get("acknowledgements") || [],
                      connections: this.ctx.getWebSockets().length,
                    });
                  }
                  if (request.method === "POST" && url.pathname === "/uninstall") {
                    for (const socket of this.ctx.getWebSockets()) {
                      socket.send(JSON.stringify({
                        type: "events_api",
                        envelope_id: "socket-uninstall",
                        payload: {
                          type: "event_callback",
                          team_id: "TWORK123",
                          api_app_id: "AGSV1234",
                          event_id: "EvUNINST01",
                          event_time: 1700000001,
                          event: { type: "app_uninstalled" },
                        },
                      }));
                    }
                    return Response.json({ sent: this.ctx.getWebSockets().length });
                  }
                  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
                    const pair = new WebSocketPair();
                    const client = pair[0];
                    const server = pair[1];
                    this.ctx.acceptWebSocket(server);
                    const connection = (await this.ctx.storage.get("sequence") || 0) + 1;
                    await this.ctx.storage.put("sequence", connection);
                    const eventId = "EvSTAND00" + connection;
                    server.send(JSON.stringify({
                      type: "events_api",
                      envelope_id: "socket-envelope-" + connection,
                      payload: {
                        type: "event_callback",
                        team_id: "TWORK123",
                        api_app_id: "AGSV1234",
                        event_id: eventId,
                        event_time: 1700000000,
                        event: {
                          type: "app_mention",
                          user: "UALICE01",
                          channel: "CGENERAL1",
                          text: "<@UGSVBOT1> standalone question",
                          ts: "1700000000.00010" + connection,
                        },
                      },
                    }));
                    return new Response(null, { status: 101, webSocket: client });
                  }
                  return new Response("Not Found", { status: 404 });
                }
                async webSocketMessage(socket, message) {
                  const acknowledgements = await this.ctx.storage.get("acknowledgements") || [];
                  acknowledgements.push(JSON.parse(message));
                  await this.ctx.storage.put("acknowledgements", acknowledgements);
                }
              }
              export default {
                async fetch(request, env) {
                  const id = env.SOCKET_SERVER.idFromName("socket");
                  return await env.SOCKET_SERVER.get(id).fetch(request);
                }
              };
            `,
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/standalone-flow.test.ts"],
  },
});
