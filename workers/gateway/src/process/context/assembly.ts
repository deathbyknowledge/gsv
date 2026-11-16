import {
  CONTEXT_LAYERS,
  type ContextLayer, type PromptAssemblyInput, type PromptAssemblySnapshot, type PromptContextProvider, type PromptSection,
  type PromptSourceRecord,
} from "./types";
import { resolvePromptProviders } from "./selection";

export async function assembleSystemPrompt(
  input: PromptAssemblyInput,
  providers: PromptContextProvider[] = resolvePromptProviders(),
): Promise<string> {
  return (await assembleSystemPromptSnapshot(input, providers)).prompt;
}

export async function assembleSystemPromptSnapshot(
  input: PromptAssemblyInput,
  providers: PromptContextProvider[] = resolvePromptProviders(),
): Promise<PromptAssemblySnapshot> {
  const contextSections: LayeredSection[] = [];
  const regularParts: string[] = [];
  const sources: PromptSourceRecord[] = [];

  // Providers read separate sources, so they load together; their order still sets the prompt's.
  const collected = await Promise.all(
    providers.map(async (provider) => ({ provider, sections: await provider.collect(input) })),
  );
  for (const { provider, sections } of collected) {
    for (const section of sections) {
      const text = section.text.trim();
      if (!text) {
        continue;
      }
      const source: PromptSourceRecord = {
        provider: provider.name,
        name: section.name,
        bytes: new TextEncoder().encode(text).byteLength,
        sha256: await sha256Hex(text),
      };
      if (section.contextRoot) source.contextRoot = section.contextRoot;
      if (section.responsibilityBaseline === true) source.responsibilityBaseline = true;
      sources.push(source);
      if (section.contextRoot) {
        contextSections.push({ ...section, text, contextRoot: section.contextRoot });
      } else {
        regularParts.push(renderSection(section.name, text));
      }
    }
  }

  const parts = [
    ...(contextSections.length > 0 ? [renderContextSections(contextSections)] : []),
    ...regularParts,
  ];
  return {
    prompt: parts.join("\n\n"),
    sources,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renderSection(name: string, text: string): string {
  const tag = sectionTagName(name);
  return `<${tag}>\n${text}\n</${tag}>`;
}

type LayeredSection = PromptSection & { contextRoot: NonNullable<PromptSection["contextRoot"]> };

/**
 * Standing context renders once per file name, in name order. Each name holds
 * its layers in precedence order, so a later layer reads as a refinement of an
 * earlier one; a legend names each layer's folder once.
 */
function renderContextSections(sections: LayeredSection[]): string {
  const layerIndex = (section: LayeredSection) => CONTEXT_LAYERS.indexOf(section.contextRoot.key);
  const roots = new Map<ContextLayer, LayeredSection["contextRoot"]>();
  const files = new Map<string, LayeredSection[]>();
  for (const section of [...sections].sort((left, right) => layerIndex(left) - layerIndex(right))) {
    const root = section.contextRoot;
    if (!roots.has(root.key)) roots.set(root.key, root);
    files.set(section.name, [...(files.get(section.name) ?? []), section]);
  }

  const width = Math.max(...[...roots.values()].map((root) => normalizePromptPath(root.location).length));
  const lines = [
    "<context_layers>",
    "Standing context is grouped by file name. Each file's layers appear in this order; a later layer takes precedence over an earlier one.",
    ...[...roots.values()].map((root) =>
      `${root.key.padEnd(6)}  ${normalizePromptPath(root.location).padEnd(width)}  ${root.access}`),
    "</context_layers>",
  ];
  for (const name of [...files.keys()].sort((left, right) => left.localeCompare(right))) {
    lines.push("", `<${name}>`);
    for (const section of files.get(name)!) {
      const layer = section.contextRoot.key;
      lines.push(`<${layer}>`, section.text.trim(), `</${layer}>`);
    }
    lines.push(`</${name}>`);
  }
  return lines.join("\n");
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
