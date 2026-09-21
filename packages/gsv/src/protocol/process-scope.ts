import * as z from "zod/mini";
import { fileResourceReferenceSchema, type FileResourceReference } from "./resource";

/** An immutable grant for a fresh Process and every descendant it creates. */
export type ProcessScopePolicy = {
  conversations: Array<{ conversationId: string; contactId: string; generation: string; read: boolean; send: boolean }>;
  resources: FileResourceReference[];
  /** Explicitly supplied text snapshots, exposed read-only under /materials/. */
  materials: Array<{ name: string; text: string }>;
  expiresAtMs: number;
  budgets: { processes: number; generations: number; messages: number };
};

const idSchema = z.string().check(z.minLength(1), z.maxLength(256));
export const processScopePolicySchema: z.ZodMiniType<ProcessScopePolicy> = z.strictObject({
  conversations: z.array(z.strictObject({
    conversationId: idSchema, contactId: idSchema, generation: idSchema, read: z.boolean(), send: z.boolean(),
  })).check(z.maxLength(8)),
  resources: z.array(fileResourceReferenceSchema).check(z.maxLength(16)),
  materials: z.array(z.strictObject({
    name: z.string().check(z.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)),
    text: z.string().check(z.maxLength(65_536)),
  })).check(z.maxLength(16)),
  expiresAtMs: z.int().check(z.positive()),
  budgets: z.strictObject({
    processes: z.int().check(z.minimum(1), z.maximum(8)),
    generations: z.int().check(z.minimum(1), z.maximum(128)),
    messages: z.int().check(z.minimum(0), z.maximum(32)),
  }),
});

export type ProcessScope = {
  id: string;
  ownerUid: number;
  rootPid: string;
  revision: number;
  state: "active" | "revoked" | "expired";
  policy: ProcessScopePolicy;
  used: { processes: number; generations: number; messages: number };
  createdAtMs: number;
};

export type ProcScopeGetArgs = { pid: string };
export type ProcScopeGetResult = { scope: ProcessScope | null };
export type ProcScopeRevokeArgs = { pid: string; expectedRevision: number };
export type ProcScopeRevokeResult = { scope: ProcessScope };
