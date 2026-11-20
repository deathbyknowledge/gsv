import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { executeCodeMode } from "../../process/codemode";
import type { JsonObject, JsonValue } from "@humansandmachines/gsv/protocol";
import { readSystemSkillPath } from "./builtin-skills";

// Runs the built-in Secret Santa skill's hat script in the real CodeMode runtime, with stand-ins for
// shell and fs, so the draw, privacy and no-duplicate promises stay true.

type Person = { name: string; contact: string; address?: string; wishes?: string[] };
type Game = { deliverTo?: string; people: Person[]; exclude?: string[][] };
type Draw = {
  round: number;
  pairs: Array<{ giver: string; recipient: string }>;
  matches: Array<{ name: string; to: string; key: string; attempt: number; message: string }>;
  yours: string | null;
};
type Delivery = { id: string; to: string; message: string; state: string };

const ID = "game1";
const GAME = `~/secret-santa/${ID}.json`;
const DRAW = `~/secret-santa/${ID}.draw.json`;
const PEOPLE: Person[] = ["owner", "c:bob", "c:carla", "c:dev", "c:eva", "c:fei"]
  .map((contact, index) => ({ name: ["Ana", "Bob", "Carla", "Dev", "Eva", "Fei"][index], contact }));
const NOTE = "Match\n{name}\n{address}\n{wishes}";

function hatScript(): string {
  const script = readSystemSkillPath("/sys/skills.d/secret-santa/hat.txt");
  if (script.kind !== "file") throw new Error("missing secret-santa hat script");
  return script.content;
}

function unquote(value: string): string {
  return value.slice(1, -1).replaceAll("'\\''", "'");
}

function option(command: string, name: string): string | null {
  const match = new RegExp(`--${name} ('(?:[^']|'\\\\'')*')`).exec(command);
  return match ? unquote(match[1]) : null;
}

class Hat {
  files = new Map<string, string>();
  // Contact deliveries by key, like `contact.send`: the same key and text return the same delivery,
  // and changed text under a used key is refused.
  deliveries = new Map<string, Delivery>();
  commands: string[] = [];
  failing = new Set<string>();
  timesOut = new Set<string>();
  readFails = false;
  private readonly source = hatScript();

  constructor(game: Game = { deliverTo: "", people: PEOPLE, exclude: [] }) {
    this.files.set(GAME, JSON.stringify(game));
  }

  async run(settings: JsonObject): Promise<JsonValue> {
    const run = await this.attempt(settings);
    if (run.status !== "completed") throw new Error(run.error);
    return run.result ?? null;
  }

  async attempt(settings: JsonObject) {
    const args = { action: "draw", r12y: `r12y:${ID}`, note: NOTE, ...settings };
    return executeCodeMode(env, this.source, (call, callArgs) => this.syscall(call, callArgs), { args });
  }

  get draw(): Draw {
    // SAFETY: the draw file only ever holds the JSON the hat script writes.
    return JSON.parse(this.files.get(DRAW) ?? "null") as Draw;
  }

  set game(game: Game) {
    this.files.set(GAME, JSON.stringify(game));
  }

  // Each message as the receiving Ship would hold it: one per delivery.
  received(to: string): string[] {
    return [...this.deliveries.values()].filter((d) => d.to === to).map((d) => d.message);
  }

  private async syscall(call: string, args: JsonObject) {
    if (call === "fs.read") {
      if (this.readFails) return { ok: false, error: "storage unavailable" };
      const content = this.files.get(String(args.path));
      return content === undefined ? { ok: false, error: "not found" } : { ok: true, path: String(args.path), content };
    }
    if (call === "fs.write") {
      this.files.set(String(args.path), String(args.content));
      return { ok: true };
    }
    if (call === "shell.exec") return this.shell(String(args.input));
    throw new Error(`unexpected call: ${call}`);
  }

  private shell(command: string) {
    this.commands.push(command);
    if (command.startsWith("test -e ")) {
      const name = unquote(command.slice(command.indexOf("secret-santa/") + "secret-santa/".length));
      return { status: "completed", exitCode: this.files.has(`~/secret-santa/${name}`) ? 0 : 1, output: "" };
    }
    if (!command.startsWith("message send ")) throw new Error(`unexpected command: ${command}`);
    const to = option(command, "to") ?? "";
    const message = option(command, "message") ?? "";
    const key = option(command, "delivery-id") ?? "";
    if (this.timesOut.has(to)) return { status: "failed", output: "", error: "Command timed out after 30000ms" };
    const existing = this.deliveries.get(key);
    if (existing && existing.message !== message) return { status: "completed", exitCode: 1, output: "Contact delivery idempotency key payload changed" };
    const delivery = existing ?? { id: `delivery:${this.deliveries.size + 1}`, to, message, state: this.failing.has(to) ? "failed" : "queued" };
    this.deliveries.set(key, delivery);
    return { status: "completed", exitCode: 0, output: `accepted=true\ndelivery_id=${delivery.id}\ndelivery_state=${delivery.state}\n` };
  }
}

describe("secret santa hat script", () => {
  it("draws one loop and sends each Ship only its own match", async () => {
    for (let run = 0; run < 25; run++) {
      const hat = new Hat();
      const result = await hat.run({});
      const pairs = hat.draw.pairs;
      expect(pairs.map((p) => p.giver).sort()).toEqual(PEOPLE.map((p) => p.contact).sort());
      expect(pairs.map((p) => p.recipient).sort()).toEqual(PEOPLE.map((p) => p.contact).sort());
      expect(pairs.every((p) => p.giver !== p.recipient)).toBe(true);
      // One loop: following recipients from anyone visits everyone.
      const next = new Map(pairs.map((p) => [p.giver, p.recipient]));
      const seen = new Set<string>();
      for (let at = "owner"; !seen.has(at); at = next.get(at)!) seen.add(at);
      expect(seen.size).toBe(PEOPLE.length);
      for (const { giver, recipient } of pairs) {
        if (giver === "owner") continue;
        const name = PEOPLE.find((p) => p.contact === recipient)!.name;
        expect(hat.received(giver)).toEqual([`Match\n${name}`]);
      }
      const owners = PEOPLE.find((p) => p.contact === pairs.find((p) => p.giver === "owner")!.recipient)!.name;
      expect(result).toEqual({ round: 1, people: 6, failed: [], yours: `Match\n${owners}` });
      expect([...hat.deliveries.keys()].sort()).toEqual(PEOPLE.filter((p) => p.contact !== "owner").map((p) => `santa:${ID}:1:${p.contact}:1`).sort());
    }
  });

  it("keeps excluded pairs apart, and says when no draw fits", async () => {
    const people = PEOPLE.slice(0, 4);
    // Ana and Bob may not draw each other, nor Carla and Dev: only Ana → Carla → Bob → Dev → Ana
    // and its reverse remain.
    const exclude = [["owner", "c:bob"], ["c:carla", "c:dev"]];
    for (let run = 0; run < 20; run++) {
      const hat = new Hat({ people, exclude });
      await hat.run({});
      for (const [a, b] of exclude) {
        expect(hat.draw.pairs.some((p) => (p.giver === a && p.recipient === b) || (p.giver === b && p.recipient === a))).toBe(false);
      }
    }
    const impossible = new Hat({ people: people.slice(0, 3), exclude: [["owner", "c:bob"]] });
    await expect(impossible.run({})).rejects.toThrow("No draw fits these exclusions");
    expect(impossible.deliveries.size).toBe(0);
    const mistyped = new Hat({ people, exclude: [["owner", "c:bobb"]] });
    await expect(mistyped.run({})).rejects.toThrow("Each exclusion must be a pair of contacts of people in the game file");
    expect(mistyped.deliveries.size).toBe(0);
  });

  it("fills the note from the game file and leaves out lines with nothing to fill", async () => {
    const people = [
      { name: "Bob", contact: "c:bob", address: "Rua X 1, Palma", wishes: ["A dotted notebook", "Jam"] },
      { name: "Carla", contact: "c:carla" },
      { name: "Dev", contact: "c:dev" },
    ];
    const hat = new Hat({ deliverTo: "The office", people });
    await hat.run({ note: "Match\n{name}\nSend to {address}\n{wishes}\nBring it to {deliverTo}" });
    const bobsGiver = hat.draw.pairs.find((p) => p.recipient === "c:bob")!.giver;
    expect(hat.received(bobsGiver)).toEqual(["Match\nBob\nSend to Rua X 1, Palma\nA dotted notebook\nJam\nBring it to The office"]);
    const carlasGiver = hat.draw.pairs.find((p) => p.recipient === "c:carla")!.giver;
    expect(hat.received(carlasGiver)).toEqual(["Match\nCarla\nBring it to The office"]);
  });

  it("refuses a note it cannot fill before saving or sending anything", async () => {
    for (const [note, error] of [
      ["Your match", "with {name} where the recipient's name goes"],
      ["{name}, within {budget}", "note has no {budget}"],
    ]) {
      const hat = new Hat();
      await expect(hat.run({ note })).rejects.toThrow(error);
      expect(hat.files.has(DRAW)).toBe(false);
      expect(hat.deliveries.size).toBe(0);
    }
  });

  it("sends nothing twice when the draw runs again, and sends a failed match again under its next key", async () => {
    const hat = new Hat();
    hat.failing.add("c:carla");
    const first = await hat.run({});
    expect(first).toMatchObject({ failed: [{ name: "Carla", state: "failed" }] });
    const pairs = hat.draw.pairs;

    hat.failing.clear();
    const again = await hat.run({});
    expect(again).toMatchObject({ round: 1, resent: true, failed: [] });
    expect(hat.draw.pairs).toEqual(pairs);
    // Everyone still holds one match; Carla's failed one went again as its second attempt.
    for (const p of PEOPLE.filter((p) => p.contact !== "owner" && p.contact !== "c:carla")) expect(hat.received(p.contact)).toHaveLength(1);
    expect(hat.deliveries.get(`santa:${ID}:1:c:carla:2`)).toMatchObject({ state: "queued" });
    expect(hat.draw.matches.find((m) => m.to === "c:carla")!.attempt).toBe(2);

    await hat.run({});
    expect(hat.deliveries.size).toBe(6);
  });

  it("finishes a draw that stopped partway with the same matches", async () => {
    const hat = new Hat();
    hat.timesOut.add("c:dev");
    const first = await hat.run({});
    expect(first).toMatchObject({ failed: [{ name: "Dev", state: expect.stringContaining("unsent") }] });
    const pairs = hat.draw.pairs;

    hat.timesOut.clear();
    await hat.run({});
    expect(hat.draw.pairs).toEqual(pairs);
    expect(hat.received("c:dev")).toHaveLength(1);
    expect(hat.deliveries.size).toBe(5);
  });

  it("draws everyone again as the next round, for someone who joins after the draw", async () => {
    const hat = new Hat({ people: PEOPLE.slice(0, 4) });
    await hat.run({});
    hat.game = { people: PEOPLE.slice(0, 5) };
    await expect(hat.run({ redraw: true, round: 1 })).rejects.toThrow("Put {round} in a redraw's note");

    const result = await hat.run({ redraw: true, round: 1, note: "Round {round} replaces your match\n{name}" });
    expect(result).toMatchObject({ round: 2, people: 5 });
    expect(hat.draw.pairs.map((p) => p.giver).sort()).toEqual(PEOPLE.slice(0, 5).map((p) => p.contact).sort());
    expect(hat.received("c:eva")).toHaveLength(1);
    expect(hat.received("c:eva")[0]).toMatch(/^Round 2 replaces your match\n/);
    expect(hat.received("c:bob")).toHaveLength(2);
    expect([...hat.deliveries.keys()].filter((key) => key.startsWith(`santa:${ID}:2:`))).toHaveLength(4);
  });

  it("sends the same redraw again when it is run again with the round it replaced", async () => {
    const hat = new Hat();
    await hat.run({});
    await expect(hat.run({ redraw: true, note: "Round {round}\n{name}" })).rejects.toThrow("Set round to 1");
    await hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" });
    const pairs = JSON.stringify(hat.draw.pairs);
    const sent = hat.deliveries.size;
    expect(await hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" })).toMatchObject({ round: 2, resent: true });
    expect(JSON.stringify(hat.draw.pairs)).toBe(pairs);
    expect(hat.deliveries.size).toBe(sent);
  });

  it("forwards a question once however Ship words it, keyed by what the person asked", async () => {
    const hat = new Hat();
    await hat.run({});
    const bobsGiver = hat.draw.pairs.find((p) => p.recipient === "c:bob")!.giver;
    if (bobsGiver === "owner") return;
    await hat.run({ action: "ask", contact: "c:bob", to: "giver", value: "do you like tea?", text: "Your recipient asks: tea?" });
    await hat.run({ action: "ask", contact: "c:bob", to: "giver", value: "do you like tea?", text: "Your recipient wonders whether you like tea." });
    expect(hat.received(bobsGiver).filter((m) => m.includes("tea"))).toHaveLength(1);
  });

  it("refuses an old round once the people changed since that redraw", async () => {
    const hat = new Hat({ people: PEOPLE.slice(0, 4) });
    await hat.run({});
    await hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" });
    hat.game = { people: PEOPLE.slice(0, 5) };
    await expect(hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" })).rejects.toThrow("set round to 2");
  });

  it("refuses a question about a round the draw has moved past", async () => {
    const hat = new Hat({ people: PEOPLE.slice(0, 4) });
    await hat.run({});
    await hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" });
    await expect(hat.run({ action: "ask", contact: "c:bob", to: "giver", round: 1, value: "tea?", text: "Tea?" })).rejects.toThrow("the draw is now round 2");
  });

  it("keeps a redraw replayable when only wishes changed", async () => {
    const hat = new Hat({ people: PEOPLE.slice(0, 4) });
    await hat.run({});
    await hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" });
    hat.game = { people: PEOPLE.slice(0, 4).map((p) => ({ ...p, wishes: ["Tea"] })) };
    expect(await hat.run({ redraw: true, round: 1, note: "Round {round}\n{name}" })).toMatchObject({ round: 2, resent: true });
  });

  it("refuses a person whose contact is not a name, before saving a draw", async () => {
    const hat = new Hat();
    // Written as raw JSON, as a hand-edited game file could be.
    hat.files.set(GAME, JSON.stringify({ people: [...PEOPLE.slice(0, 3), { name: "Alex", contact: 7 }] }));
    await expect(hat.run({})).rejects.toThrow("a name and a contact");
    expect(hat.files.has(DRAW)).toBe(false);
  });

  it("forwards a question to the giver or the recipient once, and returns one for your owner", async () => {
    const hat = new Hat();
    await hat.run({});
    const { pairs } = hat.draw;
    const bobsGiver = pairs.find((p) => p.recipient === "c:bob")!.giver;
    const bobsRecipient = pairs.find((p) => p.giver === "c:bob")!.recipient;
    const before = hat.deliveries.size;

    const toGiver = await hat.run({ action: "ask", contact: "c:bob", to: "giver", text: "Size M, please" });
    const toRecipient = await hat.run({ action: "ask", contact: "c:bob", to: "recipient", text: "Any allergies?" });
    await hat.run({ action: "ask", contact: "c:bob", to: "recipient", text: "Any allergies?" });

    for (const [result, other, text] of [[toGiver, bobsGiver, "Size M, please"], [toRecipient, bobsRecipient, "Any allergies?"]] as const) {
      if (other === "owner") expect(result).toEqual({ forYourOwner: text });
      else {
        expect(result).toEqual({ forwarded: true, state: "queued" });
        expect(hat.received(other).filter((m) => m === text)).toHaveLength(1);
      }
    }
    const forwards = [bobsGiver, bobsRecipient].filter((c) => c !== "owner").length;
    expect(hat.deliveries.size).toBe(before + forwards);
  });

  it("refuses to forward before the draw or for someone not in it", async () => {
    const hat = new Hat();
    await expect(hat.run({ action: "ask", contact: "c:bob", to: "giver", text: "Hi" })).rejects.toThrow("No draw yet");
    await hat.run({});
    await expect(hat.run({ action: "ask", contact: "c:zed", to: "giver", text: "Hi" })).rejects.toThrow("c:zed is not in the draw");
    await expect(hat.run({ action: "ask", contact: "c:bob", to: "santa", text: "Hi" })).rejects.toThrow('Set to to "giver" or "recipient"');
  });

  it("never draws again when the draw file cannot be read", async () => {
    const hat = new Hat();
    await hat.run({});
    const sent = hat.deliveries.size;
    hat.readFails = true;
    await expect(hat.run({})).rejects.toThrow("Cannot read ~/secret-santa/game1.draw.json: storage unavailable");
    expect(hat.deliveries.size).toBe(sent);
  });

  it("returns no pairs, only your owner's own match", async () => {
    const hat = new Hat();
    const result = await hat.run({});
    const shown = JSON.stringify(result);
    const owners = hat.draw.pairs.find((p) => p.giver === "owner")!.recipient;
    for (const person of PEOPLE.filter((p) => p.contact !== owners)) expect(shown).not.toContain(person.name);
  });

  it("fails on an unknown argument before any call", async () => {
    const hat = new Hat();
    const run = await hat.attempt({ recipient: "c:bob" });
    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("Unknown argument recipient") });
    expect(hat.commands).toEqual([]);
  });
});
