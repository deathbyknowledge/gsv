import type { AiConfigResult, AiContextProfile } from "../../syscalls/ai";
import type { KnowledgeStore } from "../../fs/knowledge-store";
import type { RipgitClient } from "../../fs/ripgit/client";
import type { ProcessIdentity } from "../../syscalls/system";

export type PromptKnowledgeStore = Pick<KnowledgeStore, "read" | "list">;
export type PromptRipgitClient = Pick<RipgitClient, "readPath">;

export type PromptAssemblyInput = {
  config: AiConfigResult;
  profile: AiContextProfile;
  purpose: "chat.reply" | "thread.resume";
  identity: ProcessIdentity;
  knowledge: PromptKnowledgeStore | null;
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
