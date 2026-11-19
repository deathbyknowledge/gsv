import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { executeCodeMode } from "../../process/codemode";
import type { JsonObject, JsonValue } from "@humansandmachines/gsv/protocol";
import { readSystemSkillPath } from "./builtin-skills";

// Runs the hat script from the built-in Secret Santa skill in the real CodeMode runtime,
// with stand-ins for shell and fs, so the draw, privacy and resend promises stay true.

type Person = { name: string; contact: string };
type Sent = { to: string; message: string; key: string | null; id: string };
type Pair = { giver: Person; recipient: Person };
type Game = {
  round: number;
  exclude: string[][];
  pairs?: Pair[];
  wishes: Record<string, string[]>;
  addresses: Record<string, string>;
  sent: Record<string, { deliveryId: string | null }>;
};
type Settings = {
  action?: string;
  people?: Person[];
  exclude?: string[][];
  redraw?: boolean;
  contact?: string;
  value?: string;
  to?: string;
  text?: string;
};

const PEOPLE: Person[] = ["owner", "c:bob", "c:carla", "c:dev", "c:eva", "c:fei"]
  .map((contact, index) => ({ name: ["Ana", "Bob", "Carla", "Dev", "Eva", "Fei"][index], contact }));
const NOTE = "const note = ({ name, address, wishes, replaces }) => [replaces ? \"New match\" : \"Match\", name, address ?? \"\", wishes.join(\"/\")].join(\"|\");";

function hatScript(): string {
  const skill = readSystemSkillPath("/sys/skills.d/secret-santa/SKILL.md");
  if (skill.kind !== "file") throw new Error("missing secret-santa skill");
  const start = skill.content.indexOf("```js\n") + "```js\n".length;
  return skill.content.slice(start, skill.content.indexOf("```", start));
}

function unquote(value: string): string {
  return value.slice(1, -1).replaceAll("'\\''", "'");
}

function option(command: string, name: string): string | null {
  const match = new RegExp(`--${name} ('(?:[^']|'\\\\'')*')`).exec(command);
  return match ? unquote(match[1]) : null;
}

class Hat {
  file: string | null = JSON.stringify({ round: 0, exclude: [], wishes: {}, addresses: {}, sent: {} });
  sent: Sent[] = [];
  refuse = new Set<string>();
  states = new Map<string, string>();
  private readonly source = hatScript();

  async run(settings: Settings): Promise<JsonValue> {
    let body = this.source.replace(/^const note = .*$/m, NOTE);
    for (const [name, value] of Object.entries(settings)) {
      body = body.replace(new RegExp(`^const ${name} = .*$`, "m"), `const ${name} = ${JSON.stringify(value)};`);
    }
    const run = await executeCodeMode(env, body, (call, args) => this.syscall(call, args));
    if (run.status !== "completed") throw new Error(run.error);
    return run.result ?? null;
  }

  get game(): Game {
    // SAFETY: the file only ever holds the JSON this test seeds or the hat script writes back.
    return JSON.parse(this.file ?? "null") as Game;
  }

  private async syscall(call: string, args: JsonObject) {
    if (call === "shell.exec") return this.shell(String(args.input));
    if (call === "fs.read") return this.file === null ? { ok: false, error: "not found" } : { ok: true, path: String(args.path), content: this.file };
    if (call === "fs.write") {
      this.file = String(args.content);
      return { ok: true };
    }
    throw new Error(`unexpected call: ${call}`);
  }

  private shell(command: string) {
    // Like the real command: only `delivery:` ids, and the states queued, delivered and failed.
    if (command.startsWith("message delivery show ")) {
      const id = unquote(command.slice("message delivery show ".length));
      if (!id.startsWith("delivery:")) return { status: "completed", exitCode: 1, output: "Contact delivery id is invalid" };
      const state = this.states.get(id);
      return state
        ? { status: "completed", exitCode: 0, output: `delivery_id=${id}\ndelivery_state=${state}\n` }
        : { status: "completed", exitCode: 1, output: `delivery not found: ${id}` };
    }
    if (!command.startsWith("message send ")) throw new Error(`unexpected command: ${command}`);
    const to = option(command, "to") ?? "";
    if (this.refuse.has(to)) return { status: "completed", exitCode: 1, output: "refused" };
    const sent = { to, message: option(command, "message") ?? "", key: option(command, "delivery-id"), id: `delivery:${this.sent.length + 1}` };
    this.sent.push(sent);
    return { status: "completed", exitCode: 0, output: `accepted=true\ndelivery_id=${sent.id}\ndelivery_state=queued\n` };
  }
}

function expectOneLoop(pairs: Pair[], people: Person[]) {
  expect(pairs.map((p) => p.giver.contact).sort()).toEqual(people.map((p) => p.contact).sort());
  expect(pairs.map((p) => p.recipient.contact).sort()).toEqual(people.map((p) => p.contact).sort());
  const next = new Map(pairs.map((p) => [p.giver.contact, p.recipient.contact]));
  let at = people[0].contact;
  for (let step = 1; step <= people.length; step++) {
    at = next.get(at) ?? "";
    expect(at === people[0].contact).toBe(step === people.length);
  }
}

describe.sequential("secret-santa hat script", () => {
  it("draws one fair loop that respects exclusions", async () => {
    const seen = new Set<string>();
    for (let draw = 0; draw < 200; draw++) {
      const hat = new Hat();
      const result = await hat.run({ people: PEOPLE, exclude: [["c:bob", "c:carla"]] });
      const pairs = hat.game.pairs ?? [];
      expectOneLoop(pairs, PEOPLE);
      for (const { giver, recipient } of pairs) {
        expect([giver.contact, recipient.contact].sort()).not.toEqual(["c:bob", "c:carla"]);
      }
      expect(hat.sent).toHaveLength(PEOPLE.length - 1);
      expect(result).toEqual({ people: PEOPLE.length, failed: [], yours: expect.objectContaining({ replaces: false }) });
      seen.add(pairs.map((p) => p.recipient.contact).join());
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it("sends each giver only their own match, with the wishes and address kept before the draw", async () => {
    const hat = new Hat();
    expect(await hat.run({ action: "address", contact: "c:carla", value: "Rua X 1, Palma" })).toEqual({ kept: true });
    expect(await hat.run({ action: "wish", contact: "c:carla", value: "A dotted notebook" })).toEqual({ kept: true });
    await hat.run({ people: PEOPLE, exclude: [] });

    const giver = (hat.game.pairs ?? []).find((p) => p.recipient.contact === "c:carla")?.giver;
    for (const sent of hat.sent) {
      expect(sent.message.includes("Palma")).toBe(sent.to === giver?.contact);
    }
    if (giver?.contact !== "owner") {
      expect(hat.sent.find((s) => s.to === giver?.contact)?.message).toBe("Match|Carla|Rua X 1, Palma|A dotted notebook");
    }
  });

  it("refuses a second draw, duplicate people and groups under three", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    await expect(hat.run({ people: PEOPLE, exclude: [] })).rejects.toThrow("Already drawn");
    await expect(new Hat().run({ people: [...PEOPLE, PEOPLE[1]], exclude: [] })).rejects.toThrow("appear once");
    await expect(new Hat().run({ people: PEOPLE.slice(0, 2), exclude: [] })).rejects.toThrow("at least 3");
  });

  it("redraws under a new round with new delivery ids", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const first = hat.sent.map((s) => s.key);
    await hat.run({ people: PEOPLE, exclude: [], redraw: true });
    expect(hat.game.round).toBe(2);
    expect(hat.sent.slice(first.length).every((s) => s.message.startsWith("New match") && !first.includes(s.key))).toBe(true);
  });

  it("resends only matches never accepted or failed, with the same text", async () => {
    const hat = new Hat();
    hat.refuse.add("c:bob");
    expect(await hat.run({ people: PEOPLE, exclude: [] })).toEqual(expect.objectContaining({ failed: ["Bob"] }));
    expect(Object.keys(hat.game.sent)).toHaveLength(PEOPLE.length - 1);

    const [delivered, lost, queued] = hat.sent;
    hat.states.set(delivered.id, "delivered");
    hat.states.set(lost.id, "failed");
    hat.states.set(queued.id, "queued");
    hat.refuse.clear();
    const before = hat.sent.length;
    const report = await hat.run({ action: "resend" });

    const resent = hat.sent.slice(before);
    expect(resent.map((s) => s.to).sort()).toEqual(["c:bob", lost.to].sort());
    expect(resent.find((s) => s.to === lost.to)).toEqual({ ...lost, key: (lost.key ?? "").replace(/:1$/, ":2"), id: expect.any(String) });
    expect(report).toEqual({
      delivered: 1, onTheWay: 1, unknown: PEOPLE.length - 5, resent: 2, failed: [],
      yours: expect.objectContaining({ replaces: false }),
    });
  });

  it("forwards wishes and questions after the draw without returning the pair", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const pairs = hat.game.pairs ?? [];
    const giverOfBob = pairs.find((p) => p.recipient.contact === "c:bob")?.giver.contact;
    const recipientOfBob = pairs.find((p) => p.giver.contact === "c:bob")?.recipient.contact;
    const before = hat.sent.length;

    const wish = await hat.run({ action: "wish", contact: "c:bob", value: "Socks", text: "Your recipient would like socks." });
    expect(hat.game.wishes["c:bob"]).toEqual(["Socks"]);
    expect(wish).toEqual(giverOfBob === "owner" ? { forYourOwner: true } : { forwarded: true });

    const ask = await hat.run({ action: "ask", contact: "c:bob", to: "recipient", text: "Your Secret Santa asks your size." });
    expect(ask).toEqual(recipientOfBob === "owner" ? { forYourOwner: true } : { forwarded: true });
    expect(hat.sent.slice(before).map((s) => s.to)).toEqual([giverOfBob, recipientOfBob].filter((c) => c !== "owner"));
  });

  it("re-links the leaver's giver to the leaver's recipient and keeps one loop", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const leaver = (hat.game.pairs ?? []).find((p) => p.giver.contact !== "owner" && p.recipient.contact !== "owner")?.recipient.contact ?? "";
    const before = hat.sent.length;

    await hat.run({ action: "leave", contact: leaver });

    expectOneLoop(hat.game.pairs ?? [], PEOPLE.filter((p) => p.contact !== leaver));
    expect(hat.sent.slice(before)).toHaveLength(1);
    expect(hat.sent[before].message.startsWith("New match")).toBe(true);
    await expect(hat.run({ action: "leave", contact: leaver })).rejects.toThrow("is not in the draw");
  });

  it("saves the relink when your own owner gave to the leaver", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const leaver = (hat.game.pairs ?? []).find((p) => p.giver.contact === "owner")?.recipient.contact ?? "";
    const before = hat.sent.length;

    const result = await hat.run({ action: "leave", contact: leaver });

    expect(result).toEqual(expect.objectContaining({ yours: expect.objectContaining({ replaces: true }) }));
    expectOneLoop(hat.game.pairs ?? [], PEOPLE.filter((p) => p.contact !== leaver));
    expect(hat.sent).toHaveLength(before);
    const newRecipient = (hat.game.pairs ?? []).find((p) => p.giver.contact === "owner")?.recipient.contact ?? "";
    expect(await hat.run({ action: "wish", contact: newRecipient, value: "Tea", text: "Your recipient would like tea." })).toEqual({ forYourOwner: true });
  });

  it("refuses a relink that would pair people kept apart", async () => {
    const hat = new Hat();
    const [ana, bob, carla, dev] = PEOPLE;
    const loop = [ana, bob, carla, dev];
    hat.file = JSON.stringify({
      round: 1, exclude: [["owner", "c:carla"]], wishes: {}, addresses: {}, sent: {},
      pairs: loop.map((giver, i) => ({ giver, recipient: loop[(i + 1) % loop.length] })),
    });
    await expect(hat.run({ action: "leave", contact: "c:bob" })).rejects.toThrow("Re-linking breaks the draw");
  });

  it("stops when the file cannot be read instead of starting over", async () => {
    const hat = new Hat();
    hat.file = null;
    await expect(hat.run({ people: PEOPLE, exclude: [] })).rejects.toThrow("Cannot read");
  });
});
