import type { z } from "zod";
import type { ErrorCode } from "./errors.ts";

/** Ten kinds and their verbs. The set is closed; a grant naming a verb its kind lacks is rejected. */
export const KIND_VERBS = {
  space: ["read", "admin"],
  account: ["read", "use", "manage", "share"],
  owner: ["read", "write", "approve", "share"],
  files: ["read", "write", "share"],
  machine: ["read", "write", "use", "control", "manage", "share"],
  process: ["read", "send", "control", "share"],
  responsibility: ["read", "write", "share"],
  source: ["read", "use", "manage", "share"],
  channel: ["read", "send", "manage", "share"],
  connection: ["read", "use", "manage", "share"],
} as const;

export type Kind = keyof typeof KIND_VERBS;
export type Verb<K extends Kind = Kind> = (typeof KIND_VERBS)[K][number];

/** `start` operations begin work that must never be replayed after an uncertain outcome. */
export type Effect = "read" | "effect" | "start";

export type OpDef<Name extends string = string, Args extends z.ZodType = z.ZodType, Result extends z.ZodType = z.ZodType> = {
  name: Name;
  kind: Kind;
  verb: Verb;
  effect: Effect;
  args: Args;
  result: Result;
  errors: readonly ErrorCode[];
  timeoutMs: number;
  /** Argument fields never stored in the ledger, events, logs or traces. */
  secretFields: readonly string[];
  doc: string;
};

/** Every entry names its schemas, errors, timeout and verb; the build checks the verb belongs to the kind. */
export function op<const Name extends string, Args extends z.ZodType, Result extends z.ZodType>(
  def: OpDef<Name, Args, Result>,
): OpDef<Name, Args, Result> {
  const verbs: readonly string[] = KIND_VERBS[def.kind];
  if (!verbs.includes(def.verb)) throw new Error(`${def.name}: ${def.kind} has no verb ${def.verb}`);
  return def;
}
