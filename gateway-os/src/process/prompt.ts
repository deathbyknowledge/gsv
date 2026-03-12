/**
 * Prompt assembly for Process DOs.
 *
 * Three layers assembled top-to-bottom:
 *   1. System prompt from ConfigStore (delivered via ai.config syscall)
 *   2. ~/CONSTITUTION.md — the user's core identity document
 *   3. ~/context.d/*.md — alphabetically sorted drop-in context files
 *
 * CONSTITUTION.md is a standalone file, NOT inside context.d/.
 * context.d/ is for supplementary drop-in context that the agent or user
 * can add/remove without touching the constitution.
 */

export async function buildPrompt(
  systemPrompt: string,
  home: string,
  storage: R2Bucket,
  maxContextBytes: number = 32768,
): Promise<string> {
  const parts: string[] = [systemPrompt];

  const homeKey = home.replace(/^\//, "");

  const constitutionKey = `${homeKey}/CONSTITUTION.md`;
  const constitutionObj = await storage.get(constitutionKey);
  if (constitutionObj) {
    const text = await constitutionObj.text();
    if (text.trim()) {
      parts.push(text.trim());
    }
  }

  const contextPrefix = `${homeKey}/context.d/`;
  const listed = await storage.list({ prefix: contextPrefix });

  const contextFiles: { key: string; name: string }[] = [];
  for (const obj of listed.objects) {
    if (obj.key.endsWith(".md")) {
      contextFiles.push({
        key: obj.key,
        name: obj.key.slice(contextPrefix.length),
      });
    }
  }
  contextFiles.sort((a, b) => a.name.localeCompare(b.name));

  let totalBytes = 0;
  for (const file of contextFiles) {
    const obj = await storage.get(file.key);
    if (!obj) continue;
    const text = await obj.text();
    if (!text.trim()) continue;

    const bytes = new TextEncoder().encode(text).length;
    if (totalBytes + bytes > maxContextBytes) {
      console.warn(
        `[Prompt] context.d/ budget exceeded at ${file.name}, skipping remaining`,
      );
      break;
    }
    totalBytes += bytes;
    parts.push(text.trim());
  }

  return parts.join("\n\n---\n\n");
}
