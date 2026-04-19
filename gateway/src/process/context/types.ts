import type { AiConfigResult, AiContextProfile, AiToolsDevice } from "../../syscalls/ai";
import type { ProcContextFile } from "../../syscalls/proc";
import type { RipgitClient } from "../../fs/ripgit/client";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

export type PromptStorage = Pick<R2Bucket, "get" | "list">;
export type PromptRipgitClient = Pick<RipgitClient, "readPath">;

export type PromptAssemblyInput = {
  config: AiConfigResult;
  profile: AiContextProfile;
  purpose: "chat.reply" | "thread.resume";
  identity: ProcessIdentity;
  devices: AiToolsDevice[];
  processContextFiles?: ProcContextFile[];
  storage: PromptStorage;
  ripgit: PromptRipgitClient | null;
};

export type PromptSection = {
  name: string;
  text: string;
};

export type PromptContextProvider = {
  name: string;
  collect(input: PromptAssemblyInput): Promise<PromptSection[]>;
};
