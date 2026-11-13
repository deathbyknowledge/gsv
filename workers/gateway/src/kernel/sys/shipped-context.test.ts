import { describe, expect, it } from "vitest";
import type { AiRoleContext, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RipgitClient, RipgitRepoRef } from "../../fs";
import { SYSTEM_CONFIG_DEFAULTS } from "../config";
import type { KernelContext } from "../context";
import { seededRoleContextCleanupOps, shippedRoleContext } from "./shipped-context";

// Frozen input fixture: the Ship role copy homes received from 383632989.
const COPIED_SHIP_ROLE = `# Ship

You are the user's continuous personal intelligence across interfaces. Understand what matters to them, remember what is useful, and carry work through to useful outcomes.

Computer fluency is central to your work: use websites, work with files, write and run programs, and install tools when needed. Find practical ways to accomplish the user's goals.

Build understanding over time through memory. Communicate and coordinate with people on the user's behalf. GSV is your persistent home for files, knowledge, tools and ongoing work.

Your priorities, in order:

1. Stay responsive. When a request needs work, make your first action a brief Send acknowledgment. Do only enough initial thinking to acknowledge usefully; plan and investigate afterward. An answer already at hand can be the first Send and finish the run.
2. Manage responsibilities. Make the appropriate \`r12y\` updates before starting execution or delegation, and maintain them as the work changes.
3. Move the work forward. Do short work directly; delegate when parallelism, separate context, or lengthy work helps you remain responsive. Use the Crew account named below unless a specialist is better suited. Give workers the outcome, constraints, relevant context, and completion criteria.

Keep the user informed of useful progress, material changes, and blockers. Treat new input as steering ongoing work unless the user cancels or replaces it. Ask when missing information materially affects the outcome; otherwise act with judgment.

Assess returned evidence against the whole outcome. A worker finishing is not proof of completion. Recover from failures or arrange a concrete next step; keep the promise and any later reply route in its responsibility. Close the loop with the user.

Present one coherent response without making the user coordinate workers. With other people, speak as Ship on the owner's behalf, accurately attributing their words and decisions. Apply explicit communication preferences and save your voice in \`~/context.d/05-voice.md\`.
`;

const SHIP: ProcessIdentity = { uid: 1001, gid: 1001, gids: [1001], username: "ship", home: "/home/ship", cwd: "/home/ship" };
const CREW: ProcessIdentity = { uid: 1002, gid: 1002, gids: [1002], username: "crew", home: "/home/crew", cwd: "/home/crew" };
const SCOUT: ProcessIdentity = { uid: 1003, gid: 1003, gids: [1003], username: "scout", home: "/home/scout", cwd: "/home/scout" };
const OWNER_UID = 1000;

function kernel(options: { crew?: ProcessIdentity; overrides?: Record<string, string> } = {}) {
  const values = new Map<string, string>([...Object.entries(SYSTEM_CONFIG_DEFAULTS), ...Object.entries(options.overrides ?? {})]);
  if (options.crew) values.set(`config/accounts/crew/${OWNER_UID}`, String(options.crew.uid));
  const ctx = {
    auth: {
      isPersonalAgentUid: (uid: number) => uid === SHIP.uid,
      getPasswdByUid: (uid: number) => [SHIP, CREW, SCOUT].find((account) => account.uid === uid),
    },
    config: {
      get: (key: string) => values.get(key) ?? null,
      list: (prefix: string) => [...values].filter(([key]) => key.startsWith(`${prefix}/`)).map(([key, value]) => ({ key, value })),
    },
  };
  // SAFETY: shippedRoleContext reads only these auth and config methods.
  return ctx as Pick<KernelContext, "auth" | "config">;
}

function home(files: Record<string, string>): Pick<RipgitClient, "readPath"> {
  const encoder = new TextEncoder();
  const tree = (prefix: string) => {
    const names = new Map<string, "blob" | "tree">();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${prefix}/`)) continue;
      const [name, ...rest] = path.slice(prefix.length + 1).split("/");
      names.set(name!, rest.length > 0 ? "tree" : "blob");
    }
    return names;
  };
  return {
    async readPath(_repo, path) {
      const text = files[path];
      if (text !== undefined) return { kind: "file", bytes: encoder.encode(text), size: encoder.encode(text).length };
      const entries = tree(path);
      if (entries.size === 0) return { kind: "missing" };
      return {
        kind: "tree",
        entries: [...entries].map(([name, type]) => ({ name, type, mode: type === "tree" ? "040000" : "100644", hash: name })),
      };
    },
  };
}

const REPO: RipgitRepoRef = { owner: "ship", repo: "home", branch: "main" };

describe("shipped role context", () => {
  it("gives the Ship its release files, naming its Crew", () => {
    const role = shippedRoleContext(kernel({ crew: CREW }), SHIP, OWNER_UID);
    expect(role?.role).toBe("ship");
    expect(role?.files.map((file) => file.name)).toEqual([
      "00-role.md", "05-voice.md", "06-speaking-for-the-owner.md", "10-delegation.md",
    ]);
    expect(role?.files.find((file) => file.name === "10-delegation.md")?.text).toContain("`crew`");
  });

  it("leaves out the Crew line until the Crew exists", () => {
    const role = shippedRoleContext(kernel(), SHIP, OWNER_UID);
    expect(role?.files.map((file) => file.name)).not.toContain("10-delegation.md");
  });

  it("gives the Crew its own files and other agents none", () => {
    expect(shippedRoleContext(kernel({ crew: CREW }), CREW, OWNER_UID)).toEqual({
      role: "crew",
      files: [{ name: "00-role.md", text: SYSTEM_CONFIG_DEFAULTS["config/ai/crew/context.d/00-role.md"] }],
    });
    expect(shippedRoleContext(kernel({ crew: CREW }), SCOUT, OWNER_UID)).toBeUndefined();
  });

  it("follows an operator's override of a shipped file", () => {
    const role = shippedRoleContext(kernel({ overrides: { "config/ai/ship/context.d/05-voice.md": "# Voice\n\nBe brief." } }), SHIP, OWNER_UID);
    expect(role?.files.find((file) => file.name === "05-voice.md")?.text).toBe("# Voice\n\nBe brief.");
  });
});

describe("copied role context cleanup", () => {
  const shipRole = (): AiRoleContext => shippedRoleContext(kernel({ crew: CREW }), SHIP, OWNER_UID)!;

  it("deletes copies that match a shipped revision, including the current one", async () => {
    const delegation = shipRole().files.find((file) => file.name === "10-delegation.md")!.text;
    const ops = await seededRoleContextCleanupOps(home({
      "context.d/00-role.md": COPIED_SHIP_ROLE,
      "context.d/10-delegation.md": delegation,
      "context.d/10-personal-notes.md": "Not a shipped file.",
    }), REPO, shipRole());
    expect(ops).toEqual([
      { type: "delete", path: "context.d/00-role.md" },
      { type: "delete", path: "context.d/10-delegation.md" },
    ]);
  });

  it("moves an edited copy out of the prompt without overwriting an earlier one", async () => {
    const ops = await seededRoleContextCleanupOps(home({
      "context.d/05-voice.md": "# Voice\n\nAlways answer in Dutch.\n",
      "context.d/retired/05-voice.md": "An earlier edited copy.",
    }), REPO, shipRole());
    expect(ops).toEqual([{ type: "move", from: "context.d/05-voice.md", to: "context.d/retired/05-voice-2.md" }]);
  });

  it("touches only the names of the home's own role", async () => {
    const crew = shippedRoleContext(kernel({ crew: CREW }), CREW, OWNER_UID)!;
    const ops = await seededRoleContextCleanupOps(home({
      "context.d/00-role.md": SYSTEM_CONFIG_DEFAULTS["config/ai/crew/context.d/00-role.md"],
      "context.d/05-voice.md": "A Crew file that only shares a Ship name.",
    }), { ...REPO, owner: "crew" }, crew);
    expect(ops).toEqual([{ type: "delete", path: "context.d/00-role.md" }]);
  });
});
