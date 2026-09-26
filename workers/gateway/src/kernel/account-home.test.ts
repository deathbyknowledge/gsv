import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { RipgitApplyOp } from "../fs/ripgit/client";
import { ensureAccountHomeLayout } from "./account-home";

describe("home context seeding", () => {
  it.each([false, true])("retains concurrent customizations when a home already has a revision: %s", async (existing) => {
    const files = new Map<string, string>();
    if (existing) files.set("context.d/.dir", "");
    const revisions = new Map<string, Map<string, string>>();
    let head: string | undefined;
    const commit = () => {
      head = `revision-${revisions.size + 1}`;
      revisions.set(head, new Map(files));
      return head;
    };
    if (existing) commit();
    let writes = 0;
    const customized = ["ship/00-role.md", "ship/05-voice.md", "15-memory.md"];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/refs")) return Response.json({ heads: head ? { main: head } : {}, tags: {} });
      if (url.pathname.endsWith("/read")) {
        const ref = url.searchParams.get("ref");
        const snapshot = ref && ref !== "main" ? revisions.get(ref)! : files;
        const file = snapshot.get(url.searchParams.get("path")!);
        return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
      }
      if (url.pathname.endsWith("/apply")) {
        const body: { ops: RipgitApplyOp[]; expectedHead?: string; allowEmpty?: boolean } = JSON.parse(String(init?.body));
        if (body.ops.length === 0) {
          expect(body.allowEmpty).toBe(true);
          return Response.json({ ok: true, head: commit() });
        }
        const scaffolding = body.ops.some((op) => op.type === "put" && op.path === "skills.d/.dir");
        if (scaffolding) writes += 1;
        if (scaffolding && writes === 1) {
          for (const name of customized) files.set(`context.d/${name}`, `Customized ${name}`);
          commit();
        }
        if (body.expectedHead !== head) return Response.json({ ok: false, conflict: true });
        for (const op of body.ops) {
          if (op.type === "put") files.set(op.path, new TextDecoder().decode(new Uint8Array(op.contentBytes)));
          else if (op.type === "delete") files.delete(op.path);
        }
        return Response.json({ ok: true, head: commit() });
      }
      throw new Error(`Unexpected test request: ${url.pathname}`);
    };
    await ensureAccountHomeLayout({ STORAGE: env.STORAGE, RIPGIT: { fetch } }, {
      uid: 1001, gid: 1001, gids: [1001], username: "ship", home: "/home/ship", cwd: "/home/ship",
    }, { personalAgent: true, seedPromptContext: true });
    expect(writes).toBe(2);
    for (const name of customized) expect(files.get(`context.d/${name}`)).toBe(`Customized ${name}`);
  });
});
