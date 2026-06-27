import type { PromptAssemblyInput, PromptContextProvider, PromptSection } from "./types";
import { resolvePromptProviders } from "./selection";

export async function assembleSystemPrompt(
  input: PromptAssemblyInput,
  providers: PromptContextProvider[] = resolvePromptProviders(),
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
  return parts.join("\n\n");
}

function renderSection(name: string, text: string): string {
  const tag = sectionTagName(name);
  return `<${tag}>\n${text}\n</${tag}>`;
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

  const lines: string[] = [];
  for (const { root, sections: rootSections } of roots.values()) {
    const tag = contextRootTagName(root.key);
    lines.push(`<${tag} path="${escapeAttribute(normalizePromptPath(root.location))}">`);
    for (const section of rootSections) {
      lines.push(`<${section.name}>`, section.text.trim(), `</${section.name}>`, "");
    }
    while (lines[lines.length - 1] === "") {
      lines.pop();
    }
    lines.push(`</${tag}>`, "");
  }
  while (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

function contextRootTagName(key: NonNullable<PromptSection["contextRoot"]>["key"]): string {
  return key;
}

function sectionTagName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "section";
}

function normalizePromptPath(location: string): string {
  const trimmed = location.trim();
  if (trimmed.startsWith("/") && !trimmed.endsWith("/")) {
    return `${trimmed}/`;
  }
  return trimmed;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
