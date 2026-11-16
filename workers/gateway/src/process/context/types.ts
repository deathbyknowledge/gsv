import type { AiConfigResult, AiToolsTarget, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RipgitClient } from "../../fs/ripgit/client";
import type { ContextProjection } from "./projection";

type PromptStorage = Pick<R2Bucket, "get" | "list">;
type PromptRipgitClient = Pick<RipgitClient, "readPath">;

export type PromptAssemblyInput = {
  config: AiConfigResult;
  identity: ProcessIdentity;
  /** Owning human's identity, when the process runs as a distinct agent account. */
  ownerIdentity?: ProcessIdentity;
  targets: AiToolsTarget[];
  mcpServers: string[];
  /** Frozen skill index rendered into this epoch. */
  skills: ContextProjection["skills"];
  /** Frozen runtime facts rendered into this exact epoch baseline. */
  runtime: {
    date: string;
    timezone: string;
    language?: string;
  };
  /** Frozen responsibility-ledger projection for this context epoch. */
  r12y: string;
  /** The installation's handle and canonical address rendered into this epoch; absent without a hosted identity. */
  ship?: { handle: string; origin: string; domain: string };
  /** The managed mailbox rendered into this epoch; absent when the installation has none. */
  mailbox?: { address: string };
  storage: PromptStorage;
  ripgit: PromptRipgitClient | null;
};

/** Standing context layers, in precedence order: a later layer refines an earlier one. */
export const CONTEXT_LAYERS = ["system", "role", "agent", "user"] as const;
export type ContextLayer = typeof CONTEXT_LAYERS[number];

/** Where a standing context layer lives and whether the process can change it. */
export type ContextLayerRoot = {
  key: ContextLayer;
  access: "read-only" | "editable";
  location: string;
};

export type PromptSection = {
  name: string;
  text: string;
  responsibilityBaseline?: boolean;
};

export type PromptSourceRecord = {
  provider: string;
  name: string;
  bytes: number;
  sha256: string;
  responsibilityBaseline?: boolean;
  /** The layer a standing context file comes from; same-named files render together, in layer order. */
  contextRoot?: ContextLayerRoot;
};

export type PromptAssemblySnapshot = {
  prompt: string;
  sources: PromptSourceRecord[];
};

export type PromptContextProvider = {
  name: string;
  /**
   * The standing context layer this provider's files belong to, or null when
   * the process has no such layer. A layer the process has is named in the
   * prompt even when it holds no files, so an editable one stays discoverable.
   */
  layer?(input: PromptAssemblyInput): ContextLayerRoot | null;
  collect(input: PromptAssemblyInput): Promise<PromptSection[]>;
};
