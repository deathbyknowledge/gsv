import type { AiConfigResult, AiToolsTarget, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RipgitClient } from "../../fs/ripgit/client";

type PromptStorage = Pick<R2Bucket, "get" | "list">;
type PromptRipgitClient = Pick<RipgitClient, "readPath">;

export type PromptAssemblyInput = {
  config: AiConfigResult;
  identity: ProcessIdentity;
  /** Owning human's identity, when the process runs as a distinct agent account. */
  ownerIdentity?: ProcessIdentity;
  targets: AiToolsTarget[];
  mcpServers: string[];
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

export type PromptSection = {
  name: string;
  text: string;
  responsibilityBaseline?: boolean;
  contextRoot?: {
    key: "system" | "program" | "user";
    label: string;
    access: "read-only" | "editable";
    location: string;
  };
};

export type PromptSourceRecord = {
  provider: string;
  name: string;
  bytes: number;
  sha256: string;
  responsibilityBaseline?: boolean;
  contextRoot?: PromptSection["contextRoot"];
};

export type PromptAssemblySnapshot = {
  prompt: string;
  sources: PromptSourceRecord[];
};

export type PromptContextProvider = {
  name: string;
  collect(input: PromptAssemblyInput): Promise<PromptSection[]>;
};
