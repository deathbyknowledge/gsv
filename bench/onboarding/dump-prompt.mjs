// node bench/onboarding/dump-prompt.mjs <run.requests> [i]: print the system and first user message of a request.
import { readFileSync } from "node:fs";
const requests = JSON.parse(readFileSync(process.argv[2], "utf8"));
const request = requests[Number(process.argv[3] ?? 0)];
for (const message of request.messages.slice(0, 4)) {
  const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  console.log(`\n##### ${message.role} (${text.length} chars)\n${text}`);
}
console.log(`\n##### tools: ${JSON.stringify(request.tools).length} chars`);
for (const tool of request.tools ?? []) console.log(`${tool.function.name}: ${JSON.stringify(tool.function).length}`);
console.log(`reasoning_effort=${request.reasoning_effort} max_tokens=${request.max_tokens} temperature=${request.temperature}`);
