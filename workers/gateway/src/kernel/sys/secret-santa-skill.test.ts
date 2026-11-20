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
  sent: Record<string, { deliveryId: string | null; key: string }>;
  held?: boolean;
  forwards: Array<{ to: string; who: string; key: string; deliveryId: string | null }>;
};
type Settings = {
  action?: string;
  r12y?: string;
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
  file: string | null = JSON.stringify({ round: 0, exclude: [], wishes: {}, addresses: {}, sent: {}, forwards: [], forwardCount: 0 });
  sent: Sent[] = [];
  refuse = new Set<string>();
  states = new Map<string, string>();
  writeFails = false;
  failing = new Set<string>();
  retryable = new Set<string>();
  timesOut = new Set<string>();
  lookupFails = false;
  writes: string[] = [];
  ended = new Set<string>();
  removed: string[] = [];
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
      if (this.writeFails) return { ok: false, error: "disk full" };
      this.file = String(args.content);
      this.writes.push(this.file);
      return { ok: true };
    }
    throw new Error(`unexpected call: ${call}`);
  }

  private shell(command: string) {
    // Like `message delivery show --json`: only `delivery:` ids, the states queued, delivered and
    // failed, and `delivery: null` once the record has expired.
    if (command.startsWith("message delivery show ")) {
      const id = unquote(command.slice("message delivery show ".length).replace(/ --json$/, ""));
      if (this.lookupFails) return { status: "failed", output: "", error: "lookup failed" };
      if (!id.startsWith("delivery:")) return { status: "completed", exitCode: 1, output: "Contact delivery id is invalid" };
      const state = this.states.get(id);
      const delivery = state ? { deliveryId: id, state, retryable: this.retryable.has(id) } : null;
      return { status: "completed", exitCode: 0, output: JSON.stringify({ delivery }) };
    }
    if (command === "contact list --json") {
      const contacts = PEOPLE.filter((p) => p.contact !== "owner").map((p) => ({ id: p.contact, state: this.ended.has(p.contact) ? "revoked" : "active" }));
      return { status: "completed", exitCode: 0, output: JSON.stringify({ contacts }) };
    }
    if (command.startsWith("test -e ")) return { status: "completed", exitCode: this.file === null ? 1 : 0, output: "" };
    if (command.startsWith("rm -f ")) {
      this.removed.push(command);
      this.file = null;
      return { status: "completed", exitCode: 0, output: "" };
    }
    if (!command.startsWith("message send ")) throw new Error(`unexpected command: ${command}`);
    const to = option(command, "to") ?? "";
    if (this.timesOut.has(to)) return { status: "failed", output: "", error: "Command timed out after 30000ms" };
    if (this.refuse.has(to)) return { status: "completed", exitCode: 1, output: "refused" };
    const sent = { to, message: option(command, "message") ?? "", key: option(command, "delivery-id"), id: `delivery:${this.sent.length + 1}` };
    this.sent.push(sent);
    const state = this.failing.has(to) ? "failed" : "queued";
    return { status: "completed", exitCode: 0, output: `accepted=true\ndelivery_id=${sent.id}\ndelivery_state=${state}\n` };
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

  it("waits for earlier matches on their way before a redraw", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    hat.states.set(hat.sent[0].id, "queued");
    const before = hat.sent.length;
    await expect(hat.run({ people: PEOPLE, exclude: [], redraw: true })).rejects.toThrow("on their way");
    expect(hat.sent).toHaveLength(before);
    expect(hat.game.round).toBe(1);

    hat.states.set(hat.sent[0].id, "delivered");
    await hat.run({ people: PEOPLE, exclude: [], redraw: true });
    expect(hat.game.round).toBe(2);
  });

  it("counts a match accepted but already failed as failed", async () => {
    const hat = new Hat();
    hat.failing.add("c:bob");
    expect(await hat.run({ people: PEOPLE, exclude: [] })).toEqual(expect.objectContaining({ failed: [{ who: "Bob", error: "delivery failed" }] }));
  });

  it("refuses a redraw until a send that never answered is resent", async () => {
    const hat = new Hat();
    hat.timesOut.add("c:bob");
    await hat.run({ people: PEOPLE, exclude: [] });
    await expect(hat.run({ people: PEOPLE, exclude: [], redraw: true })).rejects.toThrow("unconfirmed");
    hat.timesOut.clear();
    await hat.run({ action: "resend" });
    await hat.run({ people: PEOPLE, exclude: [], redraw: true });
    expect(hat.game.round).toBe(2);
  });

  it("waits for the giver's match to arrive before a relink", async () => {
    const hat = new Hat();
    await hat.run({ action: "address", contact: "c:dev", value: "Rua W 4, Braga" });
    await hat.run({ people: PEOPLE, exclude: [] });
    const giver = (hat.game.pairs ?? []).find((p) => p.recipient.contact === "c:dev")?.giver.contact ?? "";
    const match = hat.sent.find((s) => s.to === giver);
    if (match) hat.states.set(match.id, "queued");
    const before = hat.sent.length;

    if (match) {
      await expect(hat.run({ action: "leave", contact: "c:dev" })).rejects.toThrow("on its way");
      expect(hat.game.addresses["c:dev"]).toBe("Rua W 4, Braga");
      expect(hat.sent).toHaveLength(before);
      hat.states.set(match.id, "delivered");
    }
    await hat.run({ action: "leave", contact: "c:dev" });
    expectOneLoop(hat.game.pairs ?? [], PEOPLE.filter((p) => p.contact !== "c:dev"));
  });

  it("keeps the shell's reason when a send never ran", async () => {
    const hat = new Hat();
    hat.timesOut.add("c:bob");
    expect(await hat.run({ people: PEOPLE, exclude: [] })).toEqual(expect.objectContaining({ failed: [{ who: "Bob", error: "Command timed out after 30000ms" }] }));
  });

  it("won't replace a match whose status can't be read or that can still be retried", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    hat.lookupFails = true;
    await expect(hat.run({ people: PEOPLE, exclude: [], redraw: true })).rejects.toThrow("Cannot read a delivery");
    hat.lookupFails = false;

    hat.states.set(hat.sent[0].id, "failed");
    hat.retryable.add(hat.sent[0].id);
    await expect(hat.run({ people: PEOPLE, exclude: [], redraw: true })).rejects.toThrow("on their way");
    hat.retryable.clear();
    await hat.run({ people: PEOPLE, exclude: [], redraw: true });
    expect(hat.game.round).toBe(2);
  });

  it("holds a corrected address until the giver's earlier messages have arrived", async () => {
    const hat = new Hat();
    await hat.run({ action: "address", contact: "c:carla", value: "Rua X 1, Palma" });
    await hat.run({ people: PEOPLE, exclude: [] });
    const giver = (hat.game.pairs ?? []).find((p) => p.recipient.contact === "c:carla")?.giver.contact ?? "";
    const match = hat.sent.find((s) => s.to === giver);
    if (match) {
      hat.states.set(match.id, "queued");
      await expect(hat.run({ action: "address", contact: "c:carla", value: "Rua X 9, Palma", text: "Their new address is Rua X 9." })).rejects.toThrow("earlier messages");
      expect(hat.game.addresses["c:carla"]).toBe("Rua X 1, Palma");
      hat.states.set(match.id, "delivered");
    }
    await hat.run({ action: "address", contact: "c:carla", value: "Rua X 9, Palma", text: "Their new address is Rua X 9." });
    expect(hat.game.addresses["c:carla"]).toBe("Rua X 9, Palma");
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
    expect(await hat.run({ people: PEOPLE, exclude: [] })).toEqual(expect.objectContaining({ failed: [{ who: "Bob", error: "refused" }] }));
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
      delivered: 1, onTheWay: 1, unknown: PEOPLE.length - 5, resent: 2, earlierRetryable: 0, failed: [],
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

  it("keeps forwarded messages and resends them without naming who they were for", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const pair = (hat.game.pairs ?? []).find((p) => p.giver.contact !== "owner" && p.recipient.contact !== "owner");
    const giver = pair?.giver.contact ?? "";
    const recipient = pair?.recipient.contact ?? "";
    hat.refuse.add(giver);

    expect(await hat.run({ action: "wish", contact: recipient, value: "Tea", text: "Your recipient would like tea." })).toEqual({ forwarded: false });
    expect(hat.game.forwards).toEqual([expect.objectContaining({ to: giver, who: "a forwarded message", deliveryId: null })]);

    hat.refuse.clear();
    const before = hat.sent.length;
    const report = await hat.run({ action: "resend" });
    expect(hat.sent.slice(before)).toEqual([expect.objectContaining({ to: giver, message: "Your recipient would like tea.", key: `${hat.game.forwards[0].key}:1` })]);
    expect(report).toEqual(expect.objectContaining({ resent: 1, failed: [] }));
    expect(hat.game.forwards[0].deliveryId).toEqual(expect.any(String));
  });

  it("re-links the leaver's giver to the leaver's recipient and keeps one loop", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const leaver = (hat.game.pairs ?? []).find((p) => p.giver.contact !== "owner" && p.recipient.contact !== "owner")?.recipient.contact ?? "";
    const before = hat.sent.length;
    const writes = hat.writes.length;

    await hat.run({ action: "leave", contact: leaver });

    expectOneLoop(hat.game.pairs ?? [], PEOPLE.filter((p) => p.contact !== leaver));
    // The first write after the leave already holds the relink, never the old loop without the data.
    const firstWrite: Game = JSON.parse(hat.writes[writes]);
    expect((firstWrite.pairs ?? []).some((p) => p.giver.contact === leaver || p.recipient.contact === leaver)).toBe(false);
    expect(hat.sent.slice(before)).toHaveLength(1);
    expect(hat.sent[before].message.startsWith("New match")).toBe(true);
    await expect(hat.run({ action: "leave", contact: leaver })).rejects.toThrow("is not in the draw");
  });

  it("drops messages about a leaver so a resend can't pass them on", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const pair = (hat.game.pairs ?? []).find((p) => p.giver.contact !== "owner" && p.recipient.contact !== "owner");
    const giver = pair?.giver.contact ?? "";
    const leaver = pair?.recipient.contact ?? "";
    hat.failing.add(giver);
    await hat.run({ action: "address", contact: leaver, value: "Rua Y 2, Porto", text: "Their address is Rua Y 2, Porto." });
    expect(hat.game.forwards).toHaveLength(1);
    hat.failing.clear();
    hat.states.set(hat.sent[hat.sent.length - 1].id, "failed");

    await hat.run({ action: "leave", contact: leaver });
    const before = hat.sent.length;
    await hat.run({ action: "resend" });

    expect(hat.game.forwards).toEqual([]);
    expect(hat.sent.slice(before).some((s) => s.message.includes("Porto"))).toBe(false);
  });

  it("waits while a message about a leaver is on its way, and never reuses a forward key", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const pairs = hat.game.pairs ?? [];
    const outside = pairs.filter((p) => p.giver.contact !== "owner" && p.recipient.contact !== "owner");
    const [first, second] = outside;
    await hat.run({ action: "wish", contact: first.recipient.contact, value: "Tea", text: "Your recipient would like tea." });
    await hat.run({ action: "wish", contact: second.recipient.contact, value: "Socks", text: "Your recipient would like socks." });
    const [tea] = hat.sent.slice(-2);
    hat.states.set(tea.id, "queued");

    await expect(hat.run({ action: "leave", contact: first.recipient.contact })).rejects.toThrow("on its way");
    expect(hat.game.wishes[first.recipient.contact]).toEqual(["Tea"]);

    hat.states.set(tea.id, "delivered");
    await hat.run({ action: "leave", contact: first.recipient.contact });
    const keys = hat.game.forwards.map((f) => f.key);
    await hat.run({ action: "wish", contact: second.recipient.contact, value: "A mug", text: "Your recipient would like a mug." });
    const newKey = hat.game.forwards[hat.game.forwards.length - 1].key;
    expect(keys).not.toContain(newKey);
    expect(newKey).toMatch(/:forward:3$/);
  });

  it("waits for a leaver's own match and unconfirmed forwards about them", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const pair = (hat.game.pairs ?? []).find((p) => p.giver.contact !== "owner" && p.recipient.contact !== "owner");
    const leaver = pair?.giver.contact ?? "";
    const own = hat.sent.find((s) => s.to === leaver);
    if (own) hat.states.set(own.id, "queued");
    await expect(hat.run({ action: "leave", contact: leaver })).rejects.toThrow("on its way");
    if (own) hat.states.set(own.id, "delivered");

    const giverOfLeaver = (hat.game.pairs ?? []).find((p) => p.recipient.contact === leaver)?.giver.contact ?? "";
    if (giverOfLeaver !== "owner") {
      hat.timesOut.add(giverOfLeaver);
      await hat.run({ action: "wish", contact: leaver, value: "Tea", text: "Your recipient would like tea." });
      hat.timesOut.clear();
      await expect(hat.run({ action: "leave", contact: leaver })).rejects.toThrow("unconfirmed");
      await hat.run({ action: "resend" });
    }
    await hat.run({ action: "leave", contact: leaver });
    expectOneLoop(hat.game.pairs ?? [], PEOPLE.filter((p) => p.contact !== leaver));
  });

  it("deletes a leaver's data even when the relink is refused", async () => {
    const hat = new Hat();
    await hat.run({ action: "address", contact: "c:bob", value: "Rua Z 3, Faro" });
    await hat.run({ people: PEOPLE.slice(0, 3), exclude: [] });
    const writes = hat.writes.length;
    await expect(hat.run({ action: "leave", contact: "c:bob" })).rejects.toThrow("Re-linking breaks the draw");
    expect(hat.game.addresses["c:bob"]).toBeUndefined();
    // One write holds the draw and drops Bob's data together, so no saved state follows the old loop.
    expect(hat.writes.slice(writes)).toHaveLength(1);
    expect(hat.game.held).toBe(true);

    // The draw is on hold: nothing follows the old loop, and a resend never replays Bob's match.
    await expect(hat.run({ action: "wish", contact: "c:carla", value: "Tea", text: "Tea, please." })).rejects.toThrow("on hold");
    const before = hat.sent.length;
    await hat.run({ action: "resend" });
    expect(hat.sent.slice(before).some((s) => s.to === "c:bob")).toBe(false);
    await hat.run({ people: [PEOPLE[0], PEOPLE[2], PEOPLE[3]], exclude: [], redraw: true });
    expect(await hat.run({ action: "wish", contact: "c:carla", value: "Tea", text: "Tea, please." })).not.toEqual(expect.objectContaining({ kept: true }));
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
      round: 1, exclude: [["owner", "c:carla"]], wishes: {}, addresses: {}, sent: {}, forwards: [], forwardCount: 0,
      pairs: loop.map((giver, i) => ({ giver, recipient: loop[(i + 1) % loop.length] })),
    });
    await expect(hat.run({ action: "leave", contact: "c:bob" })).rejects.toThrow("Re-linking breaks the draw");
  });

  it("finds a loop when exclusions leave only a few, and says when none exists", async () => {
    const ring: Person[] = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, contact: i === 0 ? "owner" : `c:p${i}` }));
    const exclude: string[][] = [];
    for (let i = 0; i < ring.length; i++) {
      for (let j = i + 1; j < ring.length; j++) {
        if (j !== i + 1 && !(i === 0 && j === ring.length - 1)) exclude.push([ring[i].contact, ring[j].contact]);
      }
    }
    const hat = new Hat();
    await hat.run({ people: ring, exclude });
    const pairs = hat.game.pairs ?? [];
    expectOneLoop(pairs, ring);
    for (const { giver, recipient } of pairs) {
      expect(exclude.some(([a, b]) => [a, b].includes(giver.contact) && [a, b].includes(recipient.contact))).toBe(false);
    }

    await expect(new Hat().run({ people: PEOPLE.slice(0, 3), exclude: [["owner", "c:bob"]] })).rejects.toThrow("No draw fits");
  });

  it("sends nothing when the draw cannot be saved", async () => {
    const hat = new Hat();
    hat.writeFails = true;
    await expect(hat.run({ people: PEOPLE, exclude: [] })).rejects.toThrow("Cannot save");
    expect(hat.sent).toHaveLength(0);
  });

  it("deletes the file at close only once every message has settled", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    hat.states.set(hat.sent[0].id, "queued");
    await expect(hat.run({ action: "close" })).rejects.toThrow("on their way");
    expect(hat.file).not.toBeNull();

    hat.states.set(hat.sent[0].id, "delivered");
    expect(await hat.run({ action: "close" })).toEqual({ closed: true });
    expect(hat.removed).toEqual([`rm -f "$HOME"/'secret-santa/SLUG.json'`]);

    const held = new Hat();
    await held.run({ people: PEOPLE.slice(0, 3), exclude: [] });
    await expect(held.run({ action: "leave", contact: "c:bob" })).rejects.toThrow("on hold");
    expect(await held.run({ action: "close" })).toEqual({ closed: true });
  });

  it("holds a refused match until it is resent, unless that contact has ended", async () => {
    const hat = new Hat();
    hat.refuse.add("c:bob");
    await hat.run({ people: PEOPLE, exclude: [] });
    await expect(hat.run({ action: "close" })).rejects.toThrow("on their way");
    hat.ended.add("c:bob");
    expect(await hat.run({ action: "close" })).toEqual({ closed: true });
  });

  it("keeps a replaced attempt that can still be retried in the fence", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    const [first] = hat.sent;
    hat.states.set(first.id, "failed");
    hat.retryable.add(first.id);
    const before = hat.sent.length;
    await hat.run({ action: "resend" });
    const [second] = hat.sent.slice(before);
    hat.states.set(second.id, "delivered");

    expect(await hat.run({ action: "resend" })).toEqual(expect.objectContaining({ earlierRetryable: 1, resent: 0 }));
    await expect(hat.run({ action: "close" })).rejects.toThrow("on their way");
    hat.retryable.clear();
    expect(await hat.run({ action: "close" })).toEqual({ closed: true });
  });

  it("finishes a close whose file is already gone, and still stops on a file it can't read", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE, exclude: [] });
    expect(await hat.run({ action: "close" })).toEqual({ closed: true });
    expect(await hat.run({ action: "close" })).toEqual({ closed: true });
    await expect(hat.run({ action: "resend" })).rejects.toThrow("Cannot read");
  });

  it("keeps a late joiner's address and wishes for the redraw that adds them", async () => {
    const hat = new Hat();
    await hat.run({ people: PEOPLE.slice(0, 5), exclude: [] });
    expect(await hat.run({ action: "address", contact: "c:fei", value: "Rua V 5, Lagos" })).toEqual({ kept: true, notInDraw: true });
    expect(await hat.run({ action: "wish", contact: "c:fei", value: "Jam" })).toEqual({ kept: true, notInDraw: true });

    await hat.run({ people: PEOPLE, exclude: [], redraw: true });
    const giver = (hat.game.pairs ?? []).find((p) => p.recipient.contact === "c:fei")?.giver.contact;
    if (giver !== "owner") {
      expect(hat.sent.find((s) => s.to === giver && s.message.startsWith("New match"))?.message).toBe("New match|Fei|Rua V 5, Lagos|Jam");
    }
  });

  it("keys each game's messages by its responsibility, so a new game never replays an old one", async () => {
    const first = new Hat();
    const second = new Hat();
    await first.run({ r12y: "r12y:one", people: PEOPLE, exclude: [] });
    await second.run({ r12y: "r12y:two", people: PEOPLE, exclude: [] });
    expect(first.sent.every((s) => s.key?.startsWith("santa:r12y:one:1:"))).toBe(true);
    expect(second.sent.every((s) => s.key?.startsWith("santa:r12y:two:1:"))).toBe(true);
  });

  it("stops when the file cannot be read instead of starting over", async () => {
    const hat = new Hat();
    hat.file = null;
    await expect(hat.run({ people: PEOPLE, exclude: [] })).rejects.toThrow("Cannot read secret-santa/SLUG.json: not found");
  });
});
