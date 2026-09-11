import { readFile } from "node:fs/promises";

const providerPackages = ["@earendil-works/pi-ai", "@mariozechner/pi-ai", "openai", "@anthropic-ai/sdk", "@google/genai", "@aws-sdk/client-bedrock-runtime"];

/** Check the bundled dependency graph, including accidental external provider imports. */
export function assertGatewayInferenceBoundary(metadata) {
  const paths = [
    ...Object.keys(metadata.inputs),
    ...Object.values(metadata.outputs).flatMap((output) => output.imports.map((entry) => entry.path)),
  ].map((path) => path.replaceAll("\\", "/"));
  const forbidden = paths.filter((path) => path.includes("packages/inference/")
    || providerPackages.some((name) => path === name || path.startsWith(`${name}/`) || `/${path}`.includes(`/node_modules/${name}/`)));
  if (forbidden.length) throw new Error(`Provider execution entered the gateway bundle:\n${[...new Set(forbidden)].join("\n")}`);
}

if (import.meta.main) {
  assertGatewayInferenceBoundary(JSON.parse(await readFile(process.argv[2], "utf8")));
  console.log("Gateway bundle excludes inference execution and provider SDKs.");
}
