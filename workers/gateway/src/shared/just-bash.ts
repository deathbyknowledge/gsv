import type { Bash } from "just-bash";

export type JustBash = { Bash: typeof Bash };

let justBash: Promise<JustBash> | undefined;

/**
 * just-bash is the largest single piece of the Worker's start-up evaluation,
 * and only the native shell and the run-control parser need it. Loading it on
 * first use keeps that cost off every isolate start. A failed load is not
 * cached, so the next caller retries it.
 */
export function loadJustBash(): Promise<JustBash> {
  justBash ??= import("just-bash").catch((error) => {
    justBash = undefined;
    throw error;
  });
  return justBash;
}
