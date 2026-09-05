import type { Command } from "just-bash";

/**
 * Builds a host command the way just-bash's defineCommand does: host commands
 * are trusted, which is the boundary the native shell has always used. Defining
 * them here keeps just-bash itself out of the Worker's start-up evaluation; the
 * shell driver loads it on the first shell.exec instead.
 */
export function defineCommand(name: string, execute: Command["execute"]): Command {
  return { name, trusted: true, execute };
}
