export function slackApiWorkerScript(mode: "managed" | "standalone"): string {
  return `
    const mode = ${JSON.stringify(mode)};
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
        if (
          mode === "standalone"
          && request.method === "POST"
          && url.pathname === "/fail-next-open"
        ) {
          failNextOpen = true;
          return Response.json({ ok: true });
        }
        if (request.method === "GET" && url.pathname.startsWith("/files-pri/")) {
          const bytes = new TextEncoder().encode(mode + " inbound file");
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
        const body = request.method === "GET"
          ? Object.fromEntries(url.searchParams)
          : contentType.startsWith("application/json")
            ? await request.json()
            : Object.fromEntries(await request.formData());
        calls.push({
          method,
          body: mode === "managed"
            ? { ...body, authorization: request.headers.get("Authorization") }
            : body,
        });

        if (mode === "managed" && method === "oauth.v2.access") {
          return Response.json({
            ok: true,
            access_token: "xoxb-managed-test-token",
            bot_user_id: "UGSVBOT1",
            app_id: "AGSV1234",
            scope: "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write",
            authed_user: {
              id: "UALICE01",
              access_token: "xoxp-managed-alice-user-token",
              scope: "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read",
            },
            is_enterprise_install: false,
            team: { id: "TWORK123", name: "Acme" },
          });
        }
        if (method === "auth.test") {
          return Response.json({
            ok: true,
            team_id: "TWORK123",
            team: "Acme",
            user_id: mode === "managed" ? "UALICE01" : "UGSVBOT1",
            ...(mode === "managed" ? { user: "alice" } : {}),
          });
        }
        if (mode === "standalone" && method === "apps.connections.open") {
          if (failNextOpen) {
            failNextOpen = false;
            return Response.json({ ok: false, error: "temporary_unavailable" });
          }
          return Response.json({
            ok: true,
            url: "wss://wss-primary.slack.com/link/?ticket=test",
          });
        }
        if (mode === "managed" && method === "conversations.list") {
          if (body.cursor === "wait-for-cancel") {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5_000);
              const abort = () => {
                clearTimeout(timer);
                reject(request.signal.reason || new Error("cancelled"));
              };
              request.signal.addEventListener("abort", abort, { once: true });
              if (request.signal.aborted) abort();
            });
          }
          const channels = body.types === "im"
            ? [{
                id: "DGSVBOT1",
                user: "UGSVBOT1",
                is_im: true,
                is_private: true,
              }]
            : [{
                id: "CGENERAL1",
                name: "general",
                is_member: true,
                is_private: false,
              }];
          return Response.json({
            ok: true,
            channels,
            response_metadata: { next_cursor: "" },
          });
        }
        if (mode === "managed" && method === "conversations.info") {
          if (body.channel === "CBOTONLY1") {
            return Response.json({ ok: false, error: "channel_not_found" });
          }
          const direct = String(body.channel).startsWith("D");
          return Response.json({
            ok: true,
            channel: {
              id: body.channel,
              ...(direct ? { user: "UALICE01", is_im: true } : { name: "general" }),
              is_private: direct,
              is_member: true,
            },
          });
        }
        if (
          mode === "managed"
          && (method === "conversations.history" || method === "conversations.replies")
        ) {
          return Response.json({
            ok: true,
            messages: [{
              ts: "1700000001.000100",
              user: "UALICE01",
              text: "Hello from Slack",
            }],
            response_metadata: { next_cursor: "" },
          });
        }
        if (mode === "managed" && method === "reactions.add") {
          return Response.json({ ok: true });
        }
        if (mode === "managed" && method === "users.list") {
          return Response.json({
            ok: true,
            members: [{
              id: "UALICE01",
              name: "alice",
              real_name: "Alice",
              profile: { display_name: "Alice" },
            }],
            response_metadata: { next_cursor: "" },
          });
        }
        if (mode === "managed" && method === "users.info") {
          return Response.json({
            ok: true,
            user: {
              id: body.user,
              name: "alice",
              real_name: "Alice",
              profile: { display_name: "Alice" },
            },
          });
        }
        if (mode === "managed" && method === "conversations.open") {
          const channels = { UALICE01: "DALICE01", UBOB0001: "DBOB0001" };
          return Response.json({
            ok: true,
            channel: { id: channels[body.users] || "DUNKNOWN1" },
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
          return Response.json({ ok: true, channel: body.channel, ts: body.ts });
        }
        if (method === "files.info") {
          const bytes = new TextEncoder().encode(mode + " inbound file");
          const fileId = mode === "managed" ? "FFILE001" : "FFILE002";
          return Response.json({
            ok: true,
            file: {
              id: body.file,
              name: mode + ".txt",
              mimetype: "text/plain",
              size: bytes.byteLength,
              url_private_download:
                "https://files.slack.com/files-pri/TWORK123-" + fileId + "/" + mode + ".txt",
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
          if (mode === "managed" && body.initial_comment?.includes("Membership failure")) {
            return Response.json({ ok: false, error: "not_in_channel" });
          }
          return Response.json({ ok: true, files: body.files });
        }
        return Response.json({ ok: false, error: "unknown_method" });
      },
    };
  `;
}
