/**
 * Derive an opaque deterministic identifier without exposing provider ids or
 * message content in process, route, or delivery records.
 */
export async function stableOpaqueId(
  namespace: string,
  components: readonly (string | number | null | undefined)[],
): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(components));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${namespace}:${hex}`;
}
