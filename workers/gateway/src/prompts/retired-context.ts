// Frozen generated seeds from 55ada9d5b and 8c44f5e96^, before Knowledge moved
// into system context. Match exact content so owner edits remain untouched.
const RETIRED_CONTEXT_SHA256 = {
  ship: [
    "f77709808aaa01ee2493d81c20d51b57eb6982fb839edb997a113ca2ea19b985",
    "dac8e2dd1bb8342d0db8007b9841f19a4c805675c464253fc00c2886bd53f706",
    // The bare role seeds from 09580285b and 383632989, which still said "workers".
    "bcb10b4faee2843f785e26fe8d13e8b1e03d3e3580ba6334e12867bfdb9bb71f",
    "c80caab1459150d56c0b76b9467ab4cccedd2c5c2b84e86150f6fbe447f0ec6a",
  ],
  memory: [
    "a2fb6a401ddf5beef1f49c63b442b490b9d69af54562af22f2baffdb7aa3daf9",
    "3a30939d3e5cf9b22581b8714b3952610350da73cf5484c8694c49ea537ecc44",
    // The pre-ontology RETIRED_MEMORY_CONTEXT_TEMPLATE.
    "4ec5e8c012e39791c0dbadd171f006456b7b26458ccd0e080427dc348d6d547a",
  ],
};

export async function isRetiredGeneratedContext(
  kind: keyof typeof RETIRED_CONTEXT_SHA256,
  bytes: Uint8Array,
): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return RETIRED_CONTEXT_SHA256[kind].includes(hash);
}
