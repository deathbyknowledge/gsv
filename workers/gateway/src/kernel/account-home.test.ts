import { describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { ensureAccountHomeLayout } from "./account-home";
import { seedContextFile } from "./accounts";

const IDENTITY: ProcessIdentity = {
  uid: 1002, gid: 1002, gids: [1002, 100], username: "crew", home: "/home/crew", cwd: "/home/crew",
};

describe("account context seeding", () => {
  it.each(["00-role.md", "10-delegation.md", "00-style.md"])(
    "preserves an owner edit that races with seeding %s", async (name) => {
      const path = `context.d/${name}`;
      let head: string | null = null;
      let ownerText: string | undefined;
      const writes: Array<{ expectedHead?: string; ops: Array<{ type: string; path: string; contentBytes?: number[] }> }> = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/refs")) return Response.json({ heads: head ? { main: head } : {}, tags: {} });
        if (url.pathname.endsWith("/read")) {
          expect(url.searchParams.get("ref")).toMatch(/^(initial|edited)$/);
          if (url.searchParams.get("path") === path) {
            if (url.searchParams.get("ref") === "edited") return new Response(ownerText);
            ownerText = "Owner's instructions";
            head = "edited";
          }
          return new Response("missing", { status: 404 });
        }
        if (url.pathname.endsWith("/apply")) {
          const body = JSON.parse(String(init?.body));
          if (body.ops.length === 0) {
            expect(body.allowEmpty).toBe(true);
            head = "initial";
            return Response.json({ ok: true, head });
          }
          writes.push(body);
          if (body.expectedHead !== head) return Response.json({ ok: false, conflict: true });
          const overwrite = body.ops.find((op: { path: string }) => op.path === path);
          if (overwrite) ownerText = new TextDecoder().decode(new Uint8Array(overwrite.contentBytes));
          return Response.json({ ok: true, head });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      // SAFETY: only the Fetcher and bucket methods used by account scaffolding are exercised.
      const env = { RIPGIT: { fetch }, STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => {}) } } as Pick<Env, "STORAGE" | "RIPGIT">;
      if (name === "00-style.md") {
        await ensureAccountHomeLayout(env, IDENTITY, { seedPromptContext: true });
      } else {
        await seedContextFile(env, IDENTITY, name, "Generated default");
      }
      expect(ownerText).toBe("Owner's instructions");
      expect(writes[0]?.expectedHead).toBe("initial");
      expect(writes.slice(1).flatMap((write) => write.ops)).not.toContainEqual(expect.objectContaining({ path }));
    },
  );
});
