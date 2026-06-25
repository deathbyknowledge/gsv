import type { AiConfigResult, AiToolsDevice } from "../../syscalls/ai";
import type { ProcContextFile } from "../../syscalls/proc";
import type { RipgitClient } from "../../fs/ripgit/client";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

export type PromptStorage = Pick<R2Bucket, "get" | "list">;
export type PromptRipgitClient = Pick<RipgitClient, "readPath">;

export type PromptAssemblyInput = {
  config: AiConfigResult;
  purpose: "chat.reply" | "thread.resume";
  identity: ProcessIdentity;
  /** Owning human's identity, when the process runs as a distinct agent account. */
  ownerIdentity?: ProcessIdentity;
  devices: AiToolsDevice[];
  mcpServers: string[];
  processContextFiles?: ProcContextFile[];
  storage: PromptStorage;
  ripgit: PromptRipgitClient | null;
};

export type PromptSection = {
  name: string;
  text: string;
  contextRoot?: {
    key: "system" | "program" | "user" | "process";
    label: string;
    access: "read-only" | "editable";
    location: string;
  };
};

export type PromptContextProvider = {
  name: string;
  collect(input: PromptAssemblyInput): Promise<PromptSection[]>;
};
