import { R2MountBackend } from "../../../fs/backends/r2";
import { accountHomeRepoRef } from "../../../fs/ripgit/repos";
import type { PromptAssemblyInput, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

type AccountContextRoot = "program" | "user";

export async function collectAccountContext(
  input: PromptAssemblyInput,
  account: PromptAssemblyInput["identity"],
  root: AccountContextRoot,
  warningLabel: string,
): Promise<PromptSection[]> {
  const sections: PromptSection[] = [];
  const repo = accountHomeRepoRef(account.username);
  const contextRoot = {
    key: root,
    label: root.toUpperCase(),
    access: "editable" as const,
    location: `${account.home}/context.d`,
  };

  if (input.ripgit) {
    const contextTree = await input.ripgit.readPath(repo, "context.d");
    if (contextTree.kind === "tree") {
      const contextFiles = contextTree.entries
        .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

      let usedBytes = 0;
      for (const name of contextFiles) {
        const file = await input.ripgit.readPath(repo, `context.d/${name}`);
        if (file.kind !== "file") {
          continue;
        }

        const text = TEXT_DECODER.decode(file.bytes).trim();
        if (!text) {
          continue;
        }

        const bytes = TEXT_ENCODER.encode(text).length;
        if (usedBytes + bytes > input.config.maxContextBytes) {
          console.warn(
            `[Prompt] ${warningLabel} budget exceeded at ${name}, skipping remaining`,
          );
          break;
        }
        usedBytes += bytes;
        sections.push({ name, text, contextRoot });
      }

      return sections;
    }
  }

  const fallback = new R2MountBackend(input.storage, account);
  let contextFiles: string[];
  try {
    contextFiles = (await fallback.readdir(contextRoot.location))
      .filter((name) => name.endsWith(".md"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isMissingPath(error)) {
      return sections;
    }
    throw error;
  }

  let usedBytes = 0;
  for (const name of contextFiles) {
    let text: string;
    try {
      text = (await fallback.readFile(`${contextRoot.location}/${name}`)).trim();
    } catch (error) {
      if (isMissingPath(error)) {
        continue;
      }
      throw error;
    }
    if (!text) {
      continue;
    }

    const bytes = TEXT_ENCODER.encode(text).length;
    if (usedBytes + bytes > input.config.maxContextBytes) {
      console.warn(
        `[Prompt] ${warningLabel} budget exceeded at ${name}, skipping remaining`,
      );
      break;
    }
    usedBytes += bytes;
    sections.push({ name, text, contextRoot });
  }

  return sections;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("ENOENT:");
}
