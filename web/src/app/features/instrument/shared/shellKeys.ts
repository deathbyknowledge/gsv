/**
 * Keys the shell answers in every view, outside text fields: views, appearance and help.
 * Zen leaves them alone where any other letter would start writing, so a key never both navigates and types.
 */
export const SHELL_KEYS: ReadonlySet<string> = new Set(["z", "m", ",", "l", "x", "?"]);
