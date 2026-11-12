/**
 * Every Durable Object class the runtime exports, with the Cloudflare migration tag that introduced it.
 * The config compiler emits bindings and migrations from this list; a test keeps it equal to the exports.
 * A new class ships alone under the next tag; a shipped tag is never edited.
 */
export const DURABLE_OBJECTS = [
  { binding: "DIRECTORY", className: "Directory", since: "v1" },
  { binding: "SPACE", className: "Space", since: "v1" },
  { binding: "OWNER", className: "Owner", since: "v1" },
  { binding: "PROCESS", className: "Process", since: "v1" },
  { binding: "VOLUME", className: "Volume", since: "v1" },
  { binding: "TARGET", className: "Target", since: "v1" },
] as const;
