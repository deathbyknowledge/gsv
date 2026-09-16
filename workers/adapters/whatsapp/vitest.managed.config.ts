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
              // Sends refused on purpose (throttled or failing) are listed here
              // so tests can tell an attempt from a delivery.
              const rejected = [];
              let throttledText = null;
              let pausedSend = null;
              let resumeSend = null;
              let blockedSend = null;
              const windowRejections = new Set();
              let nextId = 100;
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/records") {
                    return Response.json(records);
                  }
                  if (request.method === "GET" && url.pathname === "/rejected") {
                    return Response.json(rejected);
                  }
                  if (request.method === "POST" && url.pathname === "/pause-send") {
                    const kind = await request.text();
                    pausedSend = { kind, promise: new Promise((resolve) => { resumeSend = resolve; }) };
                    return Response.json({ ok: true });
                  }
                  if (request.method === "GET" && url.pathname === "/paused-send") {
                    return Response.json(blockedSend);
                  }
                  if (request.method === "POST" && url.pathname === "/resume-send") {
                    resumeSend?.();
                    pausedSend = null;
                    resumeSend = null;
                    return Response.json({ ok: true });
                  }
                  // Text messages containing the posted marker are answered 429
                  // until the marker is cleared with an empty body.
                  if (request.method === "POST" && url.pathname === "/throttle") {
                    throttledText = (await request.text()) || null;
                    return Response.json({ ok: true });
                  }
                  if (url.hostname === "lookaside.test") {
                    // Media whose id ends in "vanished" was served once and is gone now.
                    if (url.pathname.endsWith("/vanished")) {
                      return new Response("Not Found", { status: 404 });
                    }
                    const bytes = new Uint8Array([1, 2, 3, 4]);
                    return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
                  }
                  const segments = url.pathname.split("/").filter(Boolean);
                  const version = segments[0];
                  if (request.method === "GET" && segments.length === 2 && segments[1] === "gone") {
                    // Meta's answer for a media id it no longer knows.
                    return Response.json(
                      { error: { message: "Unsupported get request. Object with ID 'gone' does not exist", type: "GraphMethodException", code: 100, error_subcode: 33 } },
                      { status: 400 },
                    );
                  }
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
                    const windowRejection = body.text?.body?.includes("reopen before template admission")
                      && !windowRejections.has(body.text.body);
                    const pause = pausedSend;
                    if (pause && (
                      (pause.kind === "template" && body.type === "template")
                      || (pause.kind === "window-rejection" && windowRejection)
                    )) {
                      blockedSend = body;
                      await pause.promise;
                      blockedSend = null;
                    }
                    if (windowRejection) {
                      windowRejections.add(body.text.body);
                      return Response.json(
                        { error: { message: "Re-engagement message", type: "OAuthException", code: 131047 } },
                        { status: 400 },
                      );
                    }
                    const templateText = body.template?.components?.find((component) => component.type === "body")?.parameters?.[0]?.text;
                    if (templateText?.includes("template outcome unknown")) {
                      rejected.push({ kind: "message", status: 500, body });
                      return Response.json({ error: { message: "unknown", type: "OAuthException", code: 2 } }, { status: 500 });
                    }
                    if (body.text?.body === "graph rejects this") {
                      return Response.json({ error: { message: "rejected", type: "OAuthException", code: 131026 } }, { status: 400 });
                    }
                    if (throttledText && body.text?.body?.includes(throttledText)) {
                      rejected.push({ kind: "message", status: 429, body });
                      return Response.json({ error: { message: "Too many requests", type: "OAuthException", code: 130429 } }, { status: 429 });
                    }
                    // A server failure after the request left leaves the outcome unknown.
                    if (body.text?.body?.includes("graph fails ambiguously")) {
                      rejected.push({ kind: "message", status: 500, body });
                      return Response.json({ error: { message: "unknown", type: "OAuthException", code: 2 } }, { status: 500 });
                    }
                    // Meta refuses a free-form message outside the customer service
                    // window with 131047; tests carry this marker to provoke it.
                    if (body.text?.body?.includes("outside window marker")) {
                      return Response.json(
                        { error: { message: "Re-engagement message", type: "OAuthException", code: 131047, error_subcode: 2494010 } },
                        { status: 400 },
                      );
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
    // The window scenario holds, releases and approves several messages in one flow.
    testTimeout: 30_000,
  },
});
