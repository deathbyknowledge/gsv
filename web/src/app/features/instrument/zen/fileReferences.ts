import type { MarkedExtension } from "marked";
import { escapeHtml, trimUrlPunctuation } from "../shared/markdown";
import { CLOUD_TARGET_ID } from "../fleet/fleetModel";
import type { FleetRow } from "../Instrument";
import { PLACE_REFERENCE_PREFIX } from "./zenModel";

/*
 * Paths in Ship's prose open in Work. Only the home shorthand and a few roots a file Ship saves can live under count
 * as paths, so an API route such as /v1/users or a phrase such as and/or stays text. Every linked path belongs to
 * the cloud home; a machine's paths are not told apart from the words around them.
 */
const ROOTS = ["home", "tmp", "workspace", "root", "srv", "var", "opt", "mnt", "Users"].join("|");
const PATH = new RegExp(`^(?:~|/(?:${ROOTS}))/[^\\s<>"'\`*]*`);
/** Where a path may begin: at the start of the text or after a space or an opening bracket or quote. */
const CANDIDATE = new RegExp(`(^|[\\s(\\[{"'])(?:~|/(?:${ROOTS}))/`);
const BOUNDARY = /[\s([{"']$/;

/** The fragment a linked path carries: a trailing slash names a folder, anything else is tried as a file. */
export function fileReferenceHref(path: string): string {
  if (!path.endsWith("/")) return `#file:${CLOUD_TARGET_ID}:${encodeURIComponent(path)}`;
  return `#dir:${CLOUD_TARGET_ID}:${encodeURIComponent(path.replace(/\/+$/, "") || "/")}`;
}

/** The Work row a link in Ship's text opens, or null when the link is something else. */
export function fileReferenceRow(href: string): FleetRow | null {
  const match = /^#(file|dir):([^:]+):(.+)$/.exec(href);
  if (!match) return null;
  try {
    return match[1] === "dir" ? `dir:${match[2]}:${decodeURIComponent(match[3])}` : `file:${match[2]}:${decodeURIComponent(match[3])}`;
  } catch {
    return null;
  }
}

/** The Work row a link clicked in Ship's text opens: a place it mentions or a path it names; null leaves the link alone. */
export function textLinkRow(href: string): FleetRow | null {
  if (!href.startsWith(PLACE_REFERENCE_PREFIX)) return fileReferenceRow(href);
  try {
    return `target:${decodeURIComponent(href.slice(PLACE_REFERENCE_PREFIX.length))}`;
  } catch {
    return null;
  }
}

/**
 * The markdown syntax that turns a path in prose into a link. It is an inline token, so code spans, code blocks
 * and existing links keep their text untouched.
 */
export const filePathLinks: MarkedExtension = {
  extensions: [{
    name: "filePath",
    level: "inline",
    start(src) {
      const match = CANDIDATE.exec(src);
      return match ? match.index + match[1].length : undefined;
    },
    tokenizer(src, tokens) {
      if (this.lexer.state.inLink) return undefined;
      const previous = tokens.at(-1);
      if (previous && previous.type !== "br" && !(previous.type === "text" && BOUNDARY.test(previous.raw))) return undefined;
      const match = PATH.exec(src);
      if (!match) return undefined;
      const path = trimUrlPunctuation(match[0]);
      return { type: "filePath", raw: path };
    },
    renderer(token) {
      return `<a href="${escapeHtml(fileReferenceHref(token.raw))}">${escapeHtml(token.raw)}</a>`;
    },
  }],
};
