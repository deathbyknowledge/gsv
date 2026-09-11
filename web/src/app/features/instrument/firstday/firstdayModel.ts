/** The first day, as data: four places, each lit by real state. Pure functions; the view only renders them. */

export type PlaceId = "computer" | "telegram" | "browser" | "person";

export type PlaceRow = {
  id: PlaceId;
  /** What the row is called before it is connected. */
  name: string;
  /** Why a person would connect it, in their terms. */
  sub: string;
  /** The place's label once it is connected, or null while it is not. */
  lit: string | null;
};

export type PlaceTargetInput = {
  kind: string;
  online: boolean;
  label: string;
};

export type PlaceIdentityLinkInput = {
  adapter: string;
};

export type PlaceContactInput = {
  state: string;
  alias: string | null;
};

export type PlaceInputs = {
  targets: readonly PlaceTargetInput[];
  identityLinks: readonly PlaceIdentityLinkInput[];
  contacts: readonly PlaceContactInput[];
};

export const PLACE_ORDER: readonly PlaceId[] = ["computer", "telegram", "browser", "person"];

const PLACE_COPY = {
  computer: { name: "A computer", sub: "so I can work with your files and run things for you" },
  telegram: { name: "Telegram", sub: "so you can talk to me from your phone" },
  browser: { name: "Your browser", sub: "so I can use the websites you're signed in to" },
  person: { name: "A person", sub: "so we can share files with someone who also has a ship" },
} satisfies Record<PlaceId, { name: string; sub: string }>;

export function derivePlaces(inputs: PlaceInputs): PlaceRow[] {
  const machine = inputs.targets.find((target) => target.kind === "native-device" && target.online);
  const browser = inputs.targets.find((target) => target.kind === "browser");
  const telegram = inputs.identityLinks.some((link) => link.adapter === "telegram");
  const people = inputs.contacts.filter((contact) => contact.state === "active");
  const lit = {
    computer: machine ? machine.label || "your computer" : null,
    telegram: telegram ? "Telegram" : null,
    browser: browser ? browser.label || "your browser" : null,
    person: people.length === 0 ? null : people.length === 1 ? people[0].alias || "one person" : `${people.length} people`,
  } satisfies Record<PlaceId, string | null>;
  return PLACE_ORDER.map((id) => ({ id, name: PLACE_COPY[id].name, sub: PLACE_COPY[id].sub, lit: lit[id] }));
}

export function connectedCount(rows: readonly PlaceRow[]): number {
  return rows.filter((row) => row.lit !== null).length;
}

/** The places the hello line can name as already reachable, cloud home first. */
export function reachablePlaces(rows: readonly PlaceRow[]): string[] {
  return ["your cloud home", ...rows.flatMap((row) => (row.lit === null ? [] : [row.lit]))];
}

/** Join names the way a person would say them: "a, b, and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The first row that is not yet lit, which is the one to open by default. */
export function nextToConnect(rows: readonly PlaceRow[]): PlaceId | null {
  return rows.find((row) => row.lit === null)?.id ?? null;
}

/** What a typed sentence is asking to connect, if anything. */
export function promptIntent(text: string): PlaceId | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  if (/\b(laptop|computer|desktop|mac(book)?|pc|windows|linux|machine|server)\b/.test(value)) return "computer";
  if (/\b(telegram|phone|messenger)\b/.test(value)) return "telegram";
  if (/\b(browser|chrome|extension|website|websites)\b/.test(value)) return "browser";
  if (/\b(invite|contact|person|friend|someone|share with)\b/.test(value)) return "person";
  return null;
}

export type ComputerOs = "mac" | "windows" | "linux";

/** A device id that does not collide with the ids already registered. */
export function uniqueDeviceId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
