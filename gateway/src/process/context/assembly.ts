import type { PromptAssemblyInput, PromptContextProvider, PromptSection } from "./types";
import { resolvePromptProviders } from "./selection";

export async function assembleSystemPrompt(
  input: PromptAssemblyInput,
  providers: PromptContextProvider[] = resolvePromptProviders(
    input.purpose,
  ),
): Promise<string> {
  const contextSections: PromptSection[] = [];
  const regularParts: string[] = [];

  for (const provider of providers) {
    const sections = await provider.collect(input);
    for (const section of sections) {
      const text = section.text.trim();
      if (!text) {
        continue;
      }
      if (section.contextRoot) {
        contextSections.push({ ...section, text });
      } else {
        regularParts.push(renderSection(section.name, text));
      }
    }
  }

  const parts = [
    ...(contextSections.length > 0 ? [renderContextSections(contextSections)] : []),
    ...regularParts,
  ];
  return parts.join("\n\n---\n\n");
}

function renderSection(name: string, text: string): string {
  return `[${name}]\n${text}`;
}

function renderContextSections(sections: PromptSection[]): string {
  const roots = new Map<string, { root: NonNullable<PromptSection["contextRoot"]>; sections: PromptSection[] }>();
  for (const section of sections) {
    const root = section.contextRoot;
    if (!root) continue;
    const existing = roots.get(root.key);
    if (existing) {
      existing.sections.push(section);
    } else {
      roots.set(root.key, { root, sections: [section] });
    }
  }

  const lines: string[] = ["[CONTEXT ROOTS]"];
  for (const { root } of roots.values()) {
    lines.push(`${root.label} ${root.access} ${root.location}`);
  }

  for (const { root, sections: rootSections } of roots.values()) {
    lines.push("", `[${root.label}]`);
    for (const section of rootSections) {
      lines.push(`[${section.name}]`, section.text.trim(), "");
    }
    while (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  return lines.join("\n");
}
