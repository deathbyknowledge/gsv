import type { ComponentChildren, VNode } from "preact";
import { useSyncExternalStore } from "preact/compat";
import { en } from "./en";

/** English is the source catalog: a message is written there first, and every translation supplies the same keys. */
type Source = typeof en;
export type MessageKey = keyof Source;
type PluralKey = { [Key in MessageKey]: Source[Key] extends string ? never : Key }[MessageKey];
type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
type Message = string | PluralMessage;
export type Catalog = { [Key in MessageKey]: Source[Key] extends string ? string : PluralMessage };
export type TextKey = Exclude<MessageKey, PluralKey>;
type MessageValues = Readonly<Record<string, string | number>>;
/** A plural message needs its `count`; every message fills its {name} slots from `values`. */
export type Translate = {
  (key: TextKey, values?: MessageValues): string;
  (key: PluralKey, values: MessageValues & { count: number }): string;
};
type Lookup = (key: MessageKey) => Message;
type InterfaceLocale = { tag: string; dir: "ltr" | "rtl"; load: () => Lookup | Promise<Lookup> };
type ActiveLocale = { locale: InterfaceLocale; translate: (key: MessageKey, values?: MessageValues) => string };

const PLURAL_FORMS = ["zero", "one", "two", "few", "many"] as const;
const PSEUDO_LETTERS = new Map(Object.entries({
  a: "á", c: "ç", e: "é", i: "í", n: "ñ", o: "ó", s: "š", u: "ú", y: "ý",
  A: "Á", C: "Ç", E: "É", I: "Í", N: "Ñ", O: "Ó", S: "Š", U: "Ú", Y: "Ý",
}));

const english: Lookup = (key) => en[key];
const locales: InterfaceLocale[] = [
  { tag: "en", dir: "ltr", load: () => english },
  // A translation is fetched only for someone whose language chooses it.
  { tag: "es", dir: "ltr", load: () => import("./es").then(({ es }) => (key) => es[key]) },
];
if (import.meta.env.DEV) {
  // The pseudo-locale en-XA finds text that bypasses the catalog.
  locales.push({ tag: "en-XA", dir: "ltr", load: () => (key) => pseudoMessage(en[key]) });
}

let active = activate(locales[0], english);
/** The most recently requested language, so a slower earlier load cannot replace a newer choice. */
let requested = active.locale;
const listeners = new Set<() => void>();

function isPlural(message: Message): message is PluralMessage {
  return typeof message !== "string";
}

/** Chooses the plural form for `count` and fills each {name} slot; a form the language lacks falls back to `other`. */
export function formatMessage(message: Message, plural: Intl.PluralRules, values?: MessageValues): string {
  const template = isPlural(message) ? message[plural.select(Number(values?.count))] ?? message.other : message;
  return values ? template.replace(/\{(\w+)\}/g, (slot, name: string) => name in values ? String(values[name]) : slot) : template;
}

/** Accented, bracketed and lengthened text exposes missed strings and truncation; {name} slots survive. */
function pseudoText(text: string): string {
  const accented = text.split(/(\{\w+\})/).map((part) => /^\{\w+\}$/.test(part) ? part : [...part].map((letter) => PSEUDO_LETTERS.get(letter) ?? letter).join("")).join("");
  return `[${accented}${"·".repeat(Math.ceil(text.length * 0.3))}]`;
}

function pseudoMessage(message: Message): Message {
  if (!isPlural(message)) return pseudoText(message);
  const forms: PluralMessage = { other: pseudoText(message.other) };
  for (const form of PLURAL_FORMS) {
    const text = message[form];
    if (text !== undefined) forms[form] = pseudoText(text);
  }
  return forms;
}

function activate(locale: InterfaceLocale, message: Lookup): ActiveLocale {
  const plural = new Intl.PluralRules(locale.tag);
  return { locale, translate: (key, values) => formatMessage(message(key), plural, values) };
}

/** The first supported language in the preference, then this device's languages; a regional tag such as es-MX matches its base language. */
export function resolveLocale(preference: string | undefined, device: readonly string[]): InterfaceLocale {
  for (const tag of preference ? [preference, ...device] : device) {
    const requested = tag.toLowerCase();
    const match = locales.find((locale) => locale.tag.toLowerCase() === requested)
      ?? locales.find((locale) => locale.tag === requested.split("-")[0]);
    if (match) return match;
  }
  return locales[0];
}

/**
 * Shows the interface in the preferred language when it has a catalog, otherwise in a language this device prefers, otherwise English.
 * It settles once that language's text is in place; if its catalog cannot be fetched, the interface stays in its current language.
 */
export async function applyLanguagePreference(preference?: string): Promise<void> {
  const locale = resolveLocale(preference, navigator.languages);
  requested = locale;
  let message: Lookup;
  try {
    message = await locale.load();
  } catch (error) {
    console.error(`Could not load the ${locale.tag} interface language`, error);
    return;
  }
  if (requested !== locale) return;
  document.documentElement.lang = locale.tag;
  document.documentElement.dir = locale.dir;
  if (locale === active.locale) return;
  active = activate(locale, message);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Translates in the active language. Components use {@link useT} instead, so a language change re-renders them. */
export const t: Translate = (key: MessageKey, values?: MessageValues) => active.translate(key, values);

/** The translator for a component; the component re-renders when the interface language changes. */
export function useT(): Translate {
  return useSyncExternalStore(subscribe, () => active.translate);
}

/** Places elements into a translated message's {name} slots, such as a link inside a sentence. */
export function rich(text: string, parts: Readonly<Record<string, VNode>>): ComponentChildren {
  return text.split(/(\{\w+\})/).map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name !== undefined && name in parts ? parts[name] : part;
  });
}
