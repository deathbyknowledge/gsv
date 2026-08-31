import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.managed.test.jsonc" },
      miniflare: {
        workers: [
          {
            name: "managed-telegram-gateway-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              const calls = [];
              export class AdapterGatewayEntrypoint extends WorkerEntrypoint {
                async serviceFrame(installation, frame) {
                  const bodyBytes = frame.body
                    ? Array.from(new Uint8Array(await new Response(frame.body.stream).arrayBuffer()))
                    : undefined;
                  calls.push({ installation, call: frame.call, args: frame.args, bodyBytes });
                  if (frame.args.message?.text === "__gateway_unavailable__") return null;
                  if (frame.call === "adapter.delivery.claim") {
                    return {
                      type: "res",
                      id: frame.id,
                      ok: true,
                      data: { ok: true, deliver: true },
                    };
                  }
                  if (frame.call === "adapter.delivery.report") {
                    return { type: "res", id: frame.id, ok: true, data: { ok: true } };
                  }
                  return {
                    type: "res",
                    id: frame.id,
                    ok: true,
                    data: {
                      ok: true,
                      reply: {
                        deliveryId: "gateway-reply:" + frame.args.deliveryId,
                        text: "Personal received " + frame.args.message.text,
                        replyToId: frame.args.message.messageId,
                      },
                    },
                  };
                }
                async linkedPeerFrame(installation, context, frame) {
                  calls.push({ installation, linkedContext: context, call: frame.call, args: frame.args });
                  return {
                    type: "res",
                    id: frame.id,
                    ok: true,
                    data: {
                      ok: true,
                      pid: frame.args.pid,
                      requestId: frame.args.requestId,
                      decision: frame.args.decision,
                      resumed: true,
                      remembered: frame.args.remember === true,
                    },
                  };
                }
                async unlinkManagedAdapterIdentity(installation, input) {
                  calls.push({ call: "unlinkManagedAdapterIdentity", installation, input });
                  return { removed: true };
                }
                async fetch() {
                  return Response.json(calls);
                }
              }
            `,
          },
          {
            name: "managed-telegram-api-test",
            modules: true,
            script: `
              const messages = [];
              let nextMessageId = 100;
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/messages") {
                    return Response.json(messages);
                  }
                  if (request.method === "GET" && url.pathname.includes("/file/")) {
                    const bytes = new Uint8Array([1, 2, 3, 4]);
                    return new Response(bytes, {
                      headers: { "content-length": String(bytes.byteLength) },
                    });
                  }
                  const method = url.pathname.split("/").at(-1);
                  let body;
                  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
                    body = {};
                    for (const [key, value] of await request.formData()) {
                      body[key] = typeof value === "string"
                        ? ["photo", "video", "audio", "document"].includes(key)
                          ? { bytes: Array.from(value, (character) => character.charCodeAt(0)) }
                          : value
                        : {
                            name: value.name,
                            type: value.type,
                            size: value.size,
                            bytes: Array.from(new Uint8Array(await value.arrayBuffer())),
                          };
                    }
                  } else {
                    body = await request.json();
                  }
                  if (method === "getFile") {
                    return Response.json({
                      ok: true,
                      result: {
                        file_id: body.file_id,
                        file_size: 4,
                        file_path: "voice/test.ogg",
                      },
                    });
                  }
                  if (method === "sendMessage" || method === "sendRichMessage") {
                    const result = { message_id: nextMessageId++ };
                    messages.push({
                      method,
                      body: {
                        ...body,
                        text: body.text ?? body.rich_message?.markdown ?? "",
                      },
                      result,
                    });
                    return Response.json({ ok: true, result });
                  }
                  if (["sendPhoto", "sendVideo", "sendAudio", "sendDocument"].includes(method)) {
                    const result = { message_id: nextMessageId++ };
                    messages.push({ method, body, result });
                    return Response.json({ ok: true, result });
                  }
                  if (method === "sendMediaGroup") {
                    const result = [{ message_id: nextMessageId++ }];
                    messages.push({ method, body, result });
                    return Response.json({ ok: true, result });
                  }
                  if (method === "sendChatAction") {
                    return Response.json({ ok: true, result: true });
                  }
                  if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") {
                    messages.push({ method, body, result: true });
                    return Response.json({ ok: true, result: true });
                  }
                  return Response.json({ ok: false, error_code: 400 }, { status: 400 });
                },
              };
            `,
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/managed-flow.test.ts", "test/status-query.test.ts"],
  },
});
