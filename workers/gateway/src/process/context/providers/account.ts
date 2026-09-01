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

  const homeKey = account.home.replace(/^\//, "");
  const contextPrefix = `${homeKey}/context.d/`;
  const listed = await input.storage.list({ prefix: contextPrefix });
  const contextFiles = listed.objects
    .filter((object) => object.key.endsWith(".md"))
    .map((object) => ({
      key: object.key,
      name: object.key.slice(contextPrefix.length),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  let usedBytes = 0;
  for (const file of contextFiles) {
    const object = await input.storage.get(file.key);
    if (!object) {
      continue;
    }
    const text = (await object.text()).trim();
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
