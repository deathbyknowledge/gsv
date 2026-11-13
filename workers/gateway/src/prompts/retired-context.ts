// Frozen generated memory seeds from 55ada9d5b and 8c44f5e96^, before Knowledge
// moved into system context. Match exact content so owner edits remain untouched.
const RETIRED_MEMORY_CONTEXT_SHA256 = [
  "a2fb6a401ddf5beef1f49c63b442b490b9d69af54562af22f2baffdb7aa3daf9",
  "3a30939d3e5cf9b22581b8714b3952610350da73cf5484c8694c49ea537ecc44",
  // The pre-ontology RETIRED_MEMORY_CONTEXT_TEMPLATE.
  "4ec5e8c012e39791c0dbadd171f006456b7b26458ccd0e080427dc348d6d547a",
];

export async function isRetiredMemoryContext(bytes: Uint8Array): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return RETIRED_MEMORY_CONTEXT_SHA256.includes(hash);
}
