import { hasHelpFlag } from "./args";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";

type CookieLocator =
  | { kind: "url"; url: string }
  | { kind: "domain"; domain: string };

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const COOKIES_USAGE = [
  "Usage: cookies list <url-or-domain>",
  "       cookies get <url-or-domain> <name>",
  "       cookies set <url> <name> <value>",
  "       cookies delete <url> <name>",
].join("\n");

export const cookiesCommand: BrowserCommand = {
  name: "cookies",
  summary: "List, read, set, or delete browser cookies",
  async run(args: string[]): Promise<CommandResult> {
    if (hasHelpFlag(args)) {
      return commandOk(`${COOKIES_USAGE}\n`);
    }

    const subcommand = args[0] ?? "";
    try {
      switch (subcommand) {
        case "list":
          return listCookies(args.slice(1));
        case "get":
          return getCookie(args.slice(1));
        case "set":
          return setCookie(args.slice(1));
        case "delete":
        case "rm":
          return deleteCookie(args.slice(1));
        default:
          return commandError(COOKIES_USAGE);
      }
    } catch (error) {
      return commandError(errorMessage(error));
    }
  },
};

export default cookiesCommand;

async function listCookies(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(COOKIES_USAGE);
  }

  const locator = parseUrlOrDomain(args[0]);
  if (!locator.ok) {
    return commandError(locator.error);
  }

  const results = await requireCookiesApi().getAll(cookieQueryFor(locator.value));
  return commandJson(results.map(formatCookie).sort(compareCookieRecords));
}

async function getCookie(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) {
    return commandError(COOKIES_USAGE);
  }

  const locator = parseUrlOrDomain(args[0]);
  if (!locator.ok) {
    return commandError(locator.error);
  }

  const name = validateCookieName(args[1]);
  if (!name.ok) {
    return commandError(name.error);
  }

  const cookies = requireCookiesApi();
  if (locator.value.kind === "url") {
    const cookie = await cookies.get({ url: locator.value.url, name: name.value });
    if (!cookie) {
      return commandError(`cookie not found: ${name.value}`);
    }
    return commandJson(formatCookie(cookie));
  }

  const matches = await cookies.getAll({ domain: locator.value.domain, name: name.value });
  if (matches.length === 0) {
    return commandError(`cookie not found: ${name.value}`);
  }
  if (matches.length === 1) {
    return commandJson(formatCookie(matches[0]));
  }
  return commandJson(matches.map(formatCookie).sort(compareCookieRecords));
}

async function setCookie(args: string[]): Promise<CommandResult> {
  if (args.length < 3) {
    return commandError(COOKIES_USAGE);
  }

  const url = validateCookieUrl(args[0]);
  if (!url.ok) {
    return commandError(url.error);
  }

  const name = validateCookieName(args[1]);
  if (!name.ok) {
    return commandError(name.error);
  }

  const value = validateCookieValue(args.slice(2).join(" "));
  if (!value.ok) {
    return commandError(value.error);
  }

  const cookie = await requireCookiesApi().set({
    url: url.value.url,
    name: name.value,
    value: value.value,
  });
  if (!cookie) {
    return commandError(`cookie was not set: ${name.value}`);
  }
  return commandJson(formatCookie(cookie));
}

async function deleteCookie(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) {
    return commandError(COOKIES_USAGE);
  }

  const url = validateCookieUrl(args[0]);
  if (!url.ok) {
    return commandError(url.error);
  }

  const name = validateCookieName(args[1]);
  if (!name.ok) {
    return commandError(name.error);
  }

  const removed = await requireCookiesApi().remove({
    url: url.value.url,
    name: name.value,
  }) as chrome.cookies.CookieDetails | null;
  if (!removed) {
    return commandError(`cookie not found: ${name.value}`);
  }
  return commandJson(removed);
}

function requireCookiesApi(): typeof chrome.cookies {
  if (typeof chrome === "undefined" || !chrome.cookies) {
    throw new Error("chrome.cookies is unavailable; check the cookies permission and host permissions.");
  }
  return chrome.cookies;
}

function parseUrlOrDomain(input: string | undefined): ParseResult<CookieLocator> {
  const raw = input?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: "missing url or domain" };
  }

  if (looksLikeUrl(raw)) {
    return validateCookieUrl(raw);
  }

  if (raw.includes("/") || raw.includes(":")) {
    const url = validateCookieUrl(`https://${raw}`);
    if (url.ok) {
      return url;
    }
    return { ok: false, error: `invalid url or domain: ${raw}` };
  }

  const domain = normalizeDomain(raw);
  if (!domain.ok) {
    return domain;
  }
  return { ok: true, value: { kind: "domain", domain: domain.value } };
}

function validateCookieUrl(input: string | undefined): ParseResult<Extract<CookieLocator, { kind: "url" }>> {
  const raw = input?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: "missing url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `invalid url: ${raw}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `cookie url must use http or https: ${raw}` };
  }
  return { ok: true, value: { kind: "url", url: parsed.href } };
}

function normalizeDomain(input: string): ParseResult<string> {
  const domain = input.trim().replace(/^\.+/, "").replace(/\.+$/, "").toLowerCase();
  if (!domain) {
    return { ok: false, error: "missing domain" };
  }
  if (/[/?#:\s]/.test(domain)) {
    return { ok: false, error: `invalid domain: ${input}` };
  }
  return { ok: true, value: domain };
}

function validateCookieName(input: string | undefined): ParseResult<string> {
  const name = input ?? "";
  if (!name) {
    return { ok: false, error: "missing cookie name" };
  }
  for (const character of name) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || isCookieNameSeparator(character)) {
      return { ok: false, error: `invalid cookie name: ${name}` };
    }
  }
  return { ok: true, value: name };
}

function validateCookieValue(input: string): ParseResult<string> {
  if (/[\x00-\x08\x0a-\x1f\x7f;]/.test(input)) {
    return { ok: false, error: "invalid cookie value: control characters and semicolons are not allowed" };
  }
  return { ok: true, value: input };
}

function isCookieNameSeparator(character: string): boolean {
  return "()<>@,;:\\\"/[]?={}".includes(character);
}

function looksLikeUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
}

function cookieQueryFor(locator: CookieLocator): chrome.cookies.GetAllDetails {
  return locator.kind === "url" ? { url: locator.url } : { domain: locator.domain };
}

function formatCookie(cookie: chrome.cookies.Cookie): Record<string, unknown> {
  return omitUndefined({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
    hostOnly: cookie.hostOnly,
    partitionKey: cookie.partitionKey,
  });
}

function compareCookieRecords(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return [
    String(left.domain ?? "").localeCompare(String(right.domain ?? "")),
    String(left.path ?? "").localeCompare(String(right.path ?? "")),
    String(left.name ?? "").localeCompare(String(right.name ?? "")),
  ].find((value) => value !== 0) ?? 0;
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
