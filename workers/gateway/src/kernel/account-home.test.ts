import { describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { ensureAccountHomeLayout } from "./account-home";
import { seedContextFile } from "./accounts";
import {
  RETIRED_AGENT_VOICE_CONTEXT,
  RETIRED_STYLE_CONTEXT, RETIRED_MEMORY_CONTEXT_TEMPLATE,
} from "../prompts/agent-home";
import { PERSONAL_INTELLIGENCE_CONTEXT } from "../prompts/personal-intelligence";

const IDENTITY: ProcessIdentity = {
  uid: 1002, gid: 1002, gids: [1002, 100], username: "crew", home: "/home/crew", cwd: "/home/crew",
};

// Frozen input fixtures: the shipped seeds before system Knowledge, not active defaults.
const GENERATED_SHIP_ROLE = `# Ship

You are the user's continuous personal intelligence across interfaces. Own the requested outcome and stay present while achieving it.

Your priorities, in order:

1. Stay responsive. When a request needs work, make your first action a brief Send acknowledgment. Do only enough initial thinking to acknowledge usefully; plan and investigate afterward. An answer already at hand can be the first Send and finish the run.
2. Manage responsibilities. Make the appropriate \`r12y\` updates before starting execution or delegation, and maintain them as the work changes.
3. Move the work forward. Do short work directly; delegate when parallelism, separate context, or lengthy work helps you remain responsive. Use the Crew account named below unless a specialist is better suited. Give workers the outcome, constraints, relevant context, and completion criteria.

Keep the user informed of useful progress, material changes, and blockers. Treat new input as steering ongoing work unless the user cancels or replaces it. Ask when missing information materially affects the outcome; otherwise act with judgment.

Assess returned evidence against the whole outcome. A worker finishing is not proof of completion. Recover from failures or arrange a concrete next step; keep the promise and any later reply route in its responsibility. Close the loop with the user.

Present one coherent response without making the user coordinate workers. With other people, speak as Ship on the owner's behalf, accurately attributing their words and decisions. Apply explicit communication preferences and save your voice in \`~/context.d/05-voice.md\`.
`;

const GENERATED_MEMORY = `# Knowledge

All agents of one owner share the owner's \`personal\` wiki and \`context.d/10-personal.md\`. Standing context is always loaded: keep concise, explicit facts and preferences useful almost everywhere there. The wiki holds detail retrieved when relevant. Your own context holds account instructions, not a second personal memory.

Retrieve personal history when it could change the answer or action. Honor requests to remember, preserve useful durable facts, merge duplicates, and replace superseded facts. Keep transcripts, routine activity, inferred traits, secrets, and transient details out of memory. Unfinished work belongs in \`r12y\`; reusable procedures belong in skills.

Save knowledge as it becomes useful, without waiting for context to fill. Before compaction, update the relevant memory and responsibilities, then submit \`proc compact --summary '...'\` with a concise handover. It takes effect after the current tools finish; continue the same work afterward. Include corrections, unresolved questions, decisions, relevant artifacts and the next useful actions. Omit facts already available in standing context and task bookkeeping already recorded in responsibilities.

Ship's handover preserves continuity across the user's topics and ongoing work; it is not a single task summary. A worker's handover preserves its assignment, constraints, verified findings, unsuccessful approaches and next steps. Compaction does not complete work or restart onboarding. Exact older evidence remains in Process history archives.

Read \`skills show memory\` for the workflow.
`;

const PRE_COMPACTION_MEMORY = `# Knowledge

All agents of one owner share the owner's \`personal\` wiki and \`context.d/10-personal.md\`. Standing context holds concise, explicit facts and preferences useful almost everywhere; the wiki holds detail retrieved when relevant. Your own context holds account instructions, not a second personal memory.

Retrieve personal history when it could change the answer or action. Honor requests to remember, preserve useful durable facts, merge duplicates, and replace superseded facts. Keep transcripts, routine activity, inferred traits, secrets, and transient details out of memory. Unfinished work belongs in \`r12y\`; reusable procedures belong in skills.

Read \`skills show memory\` for the workflow.
`;

function generatedShipContext(memory: string): string {
  return `${GENERATED_SHIP_ROLE.trimEnd()}\n\n${memory.trimEnd()}\n`;
}

describe("account context seeding", () => {
  it.each([
    ["old defaults", RETIRED_STYLE_CONTEXT, RETIRED_MEMORY_CONTEXT_TEMPLATE, true],
    ["latest defaults", RETIRED_AGENT_VOICE_CONTEXT, GENERATED_MEMORY, true],
    ["pre-compaction defaults", RETIRED_AGENT_VOICE_CONTEXT, PRE_COMPACTION_MEMORY, true],
    ["owner edits", `${RETIRED_STYLE_CONTEXT}My style.`, `${RETIRED_MEMORY_CONTEXT_TEMPLATE}My memory rules.`, false],
  ] as const)("retires %s only when generated, for Ship, Crew and human homes", async (_label, style, memory, retire) => {
    for (const options of [{ seedPromptContext: true, personalAgent: true }, { cleanupGeneratedPromptContext: true }, { seedPromptContext: true }]) {
      const files = new Map([
        ["context.d/00-style.md", style], ["context.d/15-memory.md", memory],
      ]);
      const deleted: string[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/refs")) return Response.json({ heads: { main: "existing" }, tags: {} });
        if (url.pathname.endsWith("/read")) {
          const text = files.get(url.searchParams.get("path") ?? "");
          return text === undefined ? new Response("missing", { status: 404 }) : new Response(text);
        }
        if (url.pathname.endsWith("/apply")) {
          const body = JSON.parse(String(init?.body));
          expect(body.expectedHead).toBe("existing");
          for (const op of body.ops) if (op.type === "delete") deleted.push(op.path);
          return Response.json({ ok: true, head: "updated" });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      // SAFETY: this fixture implements the storage operations used by home scaffolding.
      const env = { RIPGIT: { fetch }, STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => {}) } } as Pick<Env, "STORAGE" | "RIPGIT">;
      await ensureAccountHomeLayout(env, IDENTITY, options);
      const retiredPaths = [...files.keys()].sort();
      expect(deleted.sort()).toEqual(retire ? retiredPaths : []);
    }
  });

  it.each([
    ["latest generated role", GENERATED_MEMORY, ""],
    ["pre-compaction generated role", PRE_COMPACTION_MEMORY, ""],
    ["owner-edited role", GENERATED_MEMORY, "\nOwner's instructions.\n"],
  ])("reconciles %s once without changing owner edits", async (_label, memory, edit) => {
    const original = generatedShipContext(memory) + edit;
    const files = new Map([
      ["context.d/00-role.md", original],
      ["context.d/15-memory.md", memory],
    ]);
    const applied: Array<Array<{ type: string; path: string; contentBytes?: number[] }>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/refs")) return Response.json({ heads: { main: "existing" }, tags: {} });
      if (url.pathname.endsWith("/read")) {
        const path = url.searchParams.get("path") ?? "";
        if (path === "context.d" || path === "skills.d") return Response.json([]);
        const text = files.get(path);
        return text === undefined ? new Response("missing", { status: 404 }) : new Response(text);
      }
      if (url.pathname.endsWith("/apply")) {
        const body = JSON.parse(String(init?.body));
        expect(body.expectedHead).toBe("existing");
        applied.push(body.ops);
        for (const op of body.ops) {
          if (op.type === "delete") files.delete(op.path);
          else files.set(op.path, new TextDecoder().decode(new Uint8Array(op.contentBytes)));
        }
        return Response.json({ ok: true, head: "existing" });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    // SAFETY: this fixture implements the revisioned home reads and writes used by scaffolding.
    const env = { RIPGIT: { fetch }, STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => {}) } } as Pick<Env, "STORAGE" | "RIPGIT">;
    await ensureAccountHomeLayout(env, IDENTITY, { seedPromptContext: true, personalAgent: true });
    expect(files.get("context.d/00-role.md")).toBe(edit ? original : PERSONAL_INTELLIGENCE_CONTEXT);
    expect(files.has("context.d/15-memory.md")).toBe(false);
    expect(applied.flat()).not.toContainEqual(expect.objectContaining({ type: "put", path: "context.d/15-memory.md" }));
    if (edit) expect(applied.flat()).not.toContainEqual(expect.objectContaining({ path: "context.d/00-role.md" }));

    applied.length = 0;
    await ensureAccountHomeLayout(env, IDENTITY, { seedPromptContext: true, personalAgent: true });
    expect(applied).toEqual([]);
  });

  it.each(["00-role.md", "10-delegation.md", "00-style.md", "15-memory.md"])(
    "preserves an owner edit that races with seeding or retiring %s", async (name) => {
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
            if (name === "00-style.md") return new Response(RETIRED_AGENT_VOICE_CONTEXT);
            if (name === "00-role.md") return new Response(generatedShipContext(GENERATED_MEMORY));
            if (name === "15-memory.md") return new Response(GENERATED_MEMORY);
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
      if (name !== "10-delegation.md") {
        await ensureAccountHomeLayout(env, IDENTITY, { seedPromptContext: true, personalAgent: name === "00-role.md" });
      } else {
        await seedContextFile(env, IDENTITY, name, "Generated default");
      }
      expect(ownerText).toBe("Owner's instructions");
      expect(writes[0]?.expectedHead).toBe("initial");
      expect(writes.slice(1).flatMap((write) => write.ops)).not.toContainEqual(expect.objectContaining({ path }));
    },
  );
});
