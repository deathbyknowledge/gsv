import { accountHomeRepoRef } from "../../../fs/ripgit/repos";
import type { PromptAssemblyInput, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

type AccountContextRoot = "program" | "user";
type AccountContextFile = {
  name: string;
  read: () => Promise<string | null>;
};

async function listAccountContextFiles(
  input: PromptAssemblyInput,
  account: PromptAssemblyInput["identity"],
): Promise<AccountContextFile[]> {
  const ripgit = input.ripgit;
  if (ripgit) {
    const repo = accountHomeRepoRef(account.username);
    const contextTree = await ripgit.readPath(repo, "context.d");
    if (contextTree.kind === "tree") {
      return contextTree.entries
        .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
        .map((entry) => ({
          name: entry.name,
          read: async () => {
            const file = await ripgit.readPath(repo, `context.d/${entry.name}`);
            return file.kind === "file" ? TEXT_DECODER.decode(file.bytes) : null;
          },
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
  }

  const contextPrefix = `${account.home.replace(/^\//, "")}/context.d/`;
  const listed = await input.storage.list({ prefix: contextPrefix });
  return listed.objects
    .filter((object) => object.key.endsWith(".md"))
    .map((object) => ({
      name: object.key.slice(contextPrefix.length),
      read: async () => {
        const stored = await input.storage.get(object.key);
        return stored ? stored.text() : null;
      },
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function collectAccountContext(
  input: PromptAssemblyInput,
  account: PromptAssemblyInput["identity"],
  root: AccountContextRoot,
  warningLabel: string,
): Promise<PromptSection[]> {
  const sections: PromptSection[] = [];
  const contextRoot = {
    key: root,
    label: root.toUpperCase(),
    access: "editable" as const,
    location: `${account.home}/context.d`,
  };
  const contextFiles = await listAccountContextFiles(input, account);
  let usedBytes = 0;
  for (const file of contextFiles) {
    const text = (await file.read())?.trim();
    if (!text) {
      continue;
    }

    const bytes = TEXT_ENCODER.encode(text).length;
    if (usedBytes + bytes > input.config.maxContextBytes) {
      console.warn(
        `[Prompt] ${warningLabel} budget exceeded at ${file.name}, skipping remaining`,
      );
      break;
    }
    usedBytes += bytes;
    sections.push({ name: file.name, text, contextRoot });
  }

  return sections;
}
