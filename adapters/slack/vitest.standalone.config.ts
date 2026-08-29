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
                  const mediaBody = frame.body
                    ? Array.from(new Uint8Array(await new Response(frame.body.stream).arrayBuffer()))
                    : undefined;
                  calls.push({ installation, call: frame.call, args: frame.args, mediaBody });
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
              let nextFile = 0;
              let failNextOpen = false;
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/calls") {
                    return Response.json(calls);
                  }
                  if (request.method === "POST" && url.pathname === "/fail-next-open") {
                    failNextOpen = true;
                    return Response.json({ ok: true });
                  }
                  if (request.method === "GET" && url.pathname.startsWith("/files-pri/")) {
                    const bytes = new TextEncoder().encode("standalone inbound file");
                    calls.push({
                      method: "file.download",
                      body: { authorization: request.headers.get("Authorization") },
                    });
                    return new Response(bytes, {
                      headers: { "Content-Length": String(bytes.byteLength) },
                    });
                  }
                  if (request.method === "POST" && url.pathname.startsWith("/upload/v1/")) {
                    const bytes = new Uint8Array(await request.arrayBuffer());
                    calls.push({ method: "file.upload", body: { bytes: Array.from(bytes) } });
                    return new Response("OK");
                  }
                  const method = url.pathname.split("/").at(-1);
                  const contentType = request.headers.get("Content-Type") || "";
                  const body = contentType.startsWith("application/json")
                    ? await request.json()
                    : Object.fromEntries(await request.formData());
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
                    if (failNextOpen) {
                      failNextOpen = false;
                      return Response.json({ ok: false, error: "temporary_unavailable" });
                    }
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
                  if (method === "chat.update") {
                    return Response.json({
                      ok: true,
                      channel: body.channel,
                      ts: body.ts,
                    });
                  }
                  if (method === "files.info") {
                    const bytes = new TextEncoder().encode("standalone inbound file");
                    return Response.json({
                      ok: true,
                      file: {
                        id: body.file,
                        name: "standalone.txt",
                        mimetype: "text/plain",
                        size: bytes.byteLength,
                        url_private_download: "https://files.slack.com/files-pri/TWORK123-FFILE002/standalone.txt",
                      },
                    });
                  }
                  if (method === "files.getUploadURLExternal") {
                    nextFile += 1;
                    const fileId = "FUPLOAD" + nextFile;
                    return Response.json({
                      ok: true,
                      upload_url: "https://files.slack.com/upload/v1/" + fileId,
                      file_id: fileId,
                    });
                  }
                  if (method === "files.completeUploadExternal") {
                    return Response.json({ ok: true, files: body.files });
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
                  if (request.method === "POST" && url.pathname === "/disconnect") {
                    for (const socket of this.ctx.getWebSockets()) {
                      socket.send(JSON.stringify({
                        type: "disconnect",
                        reason: "warning",
                      }));
                    }
                    return Response.json({ sent: this.ctx.getWebSockets().length });
                  }
                  if (request.method === "POST" && url.pathname === "/interaction") {
                    const input = await request.json();
                    for (const socket of this.ctx.getWebSockets()) {
                      socket.send(JSON.stringify({
                        type: "interactive",
                        envelope_id: "socket-interaction",
                        payload: {
                          type: "block_actions",
                          team: { id: "TWORK123" },
                          user: { id: "UALICE01" },
                          channel: { id: "DALICE01" },
                          container: {
                            type: "message",
                            channel_id: "DALICE01",
                            message_ts: input.sourceMessageId,
                          },
                          message: {
                            user: "UGSVBOT1",
                            text: input.sourceText,
                            ts: input.sourceMessageId,
                          },
                          actions: [{
                            type: "button",
                            action_id: "gsv_hil_approve_always",
                            value: input.value,
                            action_ts: input.actionTs,
                          }],
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
                          ...(connection === 2 ? {
                            subtype: "file_share",
                            files: [{ id: "FFILE002", size: 23 }],
                          } : {}),
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
