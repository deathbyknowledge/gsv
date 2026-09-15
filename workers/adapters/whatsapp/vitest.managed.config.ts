import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.managed.test.jsonc" },
      miniflare: {
        workers: [
          {
            name: "managed-whatsapp-gateway-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              const calls = [];
              let approvalReleased = false;
              export class AdapterGatewayEntrypoint extends WorkerEntrypoint {
                async resolveInstallation(id) { return { found: true, installationId: id, state: id.startsWith("retired-") ? "retained" : "active", handle: "test", canonicalOrigin: "https://test.gsv.space" }; }
                async serviceFrame(installation, frame) {
                  const bodyBytes = frame.body
                    ? Array.from(new Uint8Array(await new Response(frame.body.stream).arrayBuffer()))
                    : undefined;
                  calls.push({ installation, call: frame.call, args: frame.args, bodyBytes });
                  if (frame.args.message?.text === "__gateway_unavailable__") return null;
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
                  if (frame.args.requestId === "held-retirement-approval") {
                    const until = Date.now() + 5000;
                    while (!approvalReleased && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
                  }
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
                async unlinkAdapterIdentity(installation, input) {
                  calls.push({ call: "unlinkAdapterIdentity", installation, input });
                  return { removed: true };
                }
                async fetch(request) {
                  if (new URL(request.url).pathname === "/release-approval") approvalReleased = true;
                  return Response.json(calls);
                }
              }
            `,
          },
          {
            name: "managed-whatsapp-api-test",
            modules: true,
            compatibilityFlags: ["formdata_parser_supports_files"],
            script: `
              // Records every Graph API call. Message sends, read receipts and
              // media uploads are listed with a kind so tests can tell them apart.
              const records = [];
              let nextId = 100;
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/records") {
                    return Response.json(records);
                  }
                  if (url.hostname === "lookaside.test") {
                    const bytes = new Uint8Array([1, 2, 3, 4]);
                    return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
                  }
                  const segments = url.pathname.split("/").filter(Boolean);
                  const version = segments[0];
                  if (request.method === "GET" && segments.length === 2) {
                    return Response.json({
                      url: "https://lookaside.test/media/" + segments[1],
                      mime_type: "audio/ogg",
                      sha256: "test",
                      file_size: 4,
                      id: segments[1],
                      messaging_product: "whatsapp",
                    });
                  }
                  if (request.method === "POST" && segments[2] === "media") {
                    const form = await request.formData();
                    const file = form.get("file");
                    const id = "media-" + nextId++;
                    const part = typeof file === "string"
                      ? { bytes: Array.from(file, (character) => character.charCodeAt(0)) }
                      : { name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
                    records.push({
                      kind: "upload",
                      version,
                      body: { type: form.get("type"), file: part },
                      result: { id },
                    });
                    return Response.json({ id });
                  }
                  if (request.method === "POST" && segments[2] === "messages") {
                    const body = await request.json();
                    if (body.status === "read") {
                      records.push({ kind: "read", version, phoneNumberId: segments[1], body, result: { success: true } });
                      return Response.json({ success: true });
                    }
                    if (body.text?.body === "graph rejects this") {
                      return Response.json({ error: { message: "rejected", type: "OAuthException", code: 131026 } }, { status: 400 });
                    }
                    const result = { id: "wamid.out." + nextId++ };
                    records.push({ kind: "message", version, phoneNumberId: segments[1], body, result });
                    return Response.json({
                      messaging_product: "whatsapp",
                      contacts: [{ input: body.to, wa_id: body.to }],
                      messages: [result],
                    });
                  }
                  return Response.json({ error: { message: "unknown route", code: 100 } }, { status: 400 });
                },
              };
            `,
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/managed-flow.test.ts", "test/retirement.test.ts"],
  },
});
