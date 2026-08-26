import type {
  AiConfigResult,
  AiToolsDevice,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { RipgitClient } from "../../fs/ripgit/client";

export type PromptStorage = Pick<R2Bucket, "get" | "list">;
export type PromptRipgitClient = Pick<RipgitClient, "readPath">;

export type PromptAssemblyInput = {
  config: AiConfigResult;
  identity: ProcessIdentity;
  /** Owning human's identity, when the process runs as a distinct agent account. */
  ownerIdentity?: ProcessIdentity;
  devices: AiToolsDevice[];
  mcpServers: string[];
  /** Frozen responsibility-ledger projection for this context epoch. */
  r12y: string;
  storage: PromptStorage;
  ripgit: PromptRipgitClient | null;
};

export type PromptSection = {
  name: string;
  text: string;
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
