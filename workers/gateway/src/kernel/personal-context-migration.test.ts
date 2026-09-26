import { describe, expect, it, vi } from "vitest";
import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { migratePersonalContext, PERSONAL_CONTEXT_MIGRATION_MARKER } from "./personal-context-migration";
import { LEGACY_PERSONAL_INTELLIGENCE_CONTEXT, LEGACY_PERSONAL_INTELLIGENCE_VOICE_CONTEXT } from "../prompts/legacy-personal-intelligence";
import { PERSONAL_INTELLIGENCE_CONTEXT, PERSONAL_INTELLIGENCE_VOICE_CONTEXT } from "../prompts/personal-intelligence";

function fixture(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  let head = "revision-1";
  let changeBeforeApply = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/refs")) return Response.json({ heads: { main: head }, tags: {} });
    if (url.pathname.endsWith("/read")) {
      const file = files.get(url.searchParams.get("path")!);
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
    }
    if (url.pathname.endsWith("/apply")) {
      const body: { expectedHead: string; ops: RipgitApplyOp[] } = JSON.parse(String(init?.body));
      if (changeBeforeApply) {
        files.set("context.d/00-role.md", "Edited during migration");
        head = "revision-2";
        changeBeforeApply = false;
      }
      if (body.expectedHead !== head) return Response.json({ ok: false, conflict: true, error: "ref moved" });
      for (const op of body.ops) {
        if (op.type === "put") files.set(op.path, new TextDecoder().decode(new Uint8Array(op.contentBytes)));
        if (op.type === "delete") files.delete(op.path);
      }
      head = "revision-3";
      return Response.json({ ok: true, head });
    }
    throw new Error(`unexpected test path: ${url.pathname}`);
  });
  const client = new RipgitClient({ fetch });
  return { files, fetch, client, editDuringApply: () => { changeBeforeApply = true; } };
}

const repo = { owner: "algo", repo: "home" };

describe("personal context migration", () => {
  it("updates exact shipped defaults once and leaves unrelated files intact", async () => {
    const { client, files, fetch } = fixture({
      "context.d/00-role.md": LEGACY_PERSONAL_INTELLIGENCE_CONTEXT,
      "context.d/05-voice.md": LEGACY_PERSONAL_INTELLIGENCE_VOICE_CONTEXT,
      "context.d/10-personal.md": "Custom shared context",
    });
    await migratePersonalContext(client, repo, "ship");
    const migrated = [...files];
    await migratePersonalContext(client, repo, "ship");
    expect([...files]).toEqual(migrated);
    expect(files.get("context.d/ship/00-role.md")).toBe(PERSONAL_INTELLIGENCE_CONTEXT);
    expect(files.get("context.d/ship/05-voice.md")).toBe(PERSONAL_INTELLIGENCE_VOICE_CONTEXT);
    expect(files.get("context.d/10-personal.md")).toBe("Custom shared context");
    expect(files.has("context.d/00-role.md")).toBe(false);
    expect(files.has("context.d/05-voice.md")).toBe(false);
    expect(files.has(PERSONAL_CONTEXT_MIGRATION_MARKER)).toBe(true);
    files.set("context.d/00-role.md", "New shared instructions after upgrade");
    await migratePersonalContext(client, repo, "ship");
    expect(files.get("context.d/00-role.md")).toBe("New shared instructions after upgrade");
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/apply"))).toHaveLength(1);
  });

  it("retains customized files byte for byte, including occupied destinations", async () => {
    const original = "# Owner's policy\r\n\r\nCustom content.\r\n";
    const { client, files } = fixture({
      "context.d/00-role.md": original,
      "context.d/05-voice.md": "Custom voice",
      "context.d/ship/00-role.md": "Existing scoped policy",
    });
    await migratePersonalContext(client, repo, "ship");
    expect(files.get("context.d/ship/00-role.md")).toBe("Existing scoped policy");
    expect(files.get("context.d/ship/05-voice.md")).toBe("Custom voice");
    expect([...files].find(([name]) => name.startsWith("context.d/ship/00-role.previous-"))?.[1]).toBe(original);
    expect([...files.keys()].every((name) => name.startsWith("context.d/ship/") || name === PERSONAL_CONTEXT_MIGRATION_MARKER)).toBe(true);
  });

  it.each([false, true])("retries a concurrent legacy edit when a legacy file initially exists: %s", async (existing) => {
    const state = fixture(existing ? { "context.d/00-role.md": LEGACY_PERSONAL_INTELLIGENCE_CONTEXT } : {});
    state.editDuringApply();
    await migratePersonalContext(state.client, repo, "ship");
    expect(state.files.get("context.d/ship/00-role.md")).toBe("Edited during migration");
    expect(state.files.has("context.d/00-role.md")).toBe(false);
    expect(state.files.has(PERSONAL_CONTEXT_MIGRATION_MARKER)).toBe(true);
    expect(state.fetch.mock.calls.filter(([input]) => String(input).endsWith("/apply"))).toHaveLength(2);
  });
});
