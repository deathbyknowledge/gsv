import type { PromptAssemblyInput, PromptContextProvider } from "./types";
import { resolvePromptProviders } from "./selection";

export async function assembleSystemPrompt(
  input: PromptAssemblyInput,
  providers: PromptContextProvider[] = resolvePromptProviders(
    input.profile,
    input.purpose,
  ),
): Promise<string> {
  const parts: string[] = [];

  for (const provider of providers) {
    const sections = await provider.collect(input);
    for (const section of sections) {
      const text = section.text.trim();
      if (!text) {
        continue;
      }
      parts.push(renderSection(section.name, text));
    }
  }

  return parts.join("\n\n---\n\n");
}

function renderSection(name: string, text: string): string {
  return `[${name}]\n${text}`;
}
