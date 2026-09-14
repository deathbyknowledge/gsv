import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { aiGatewayLogCaptureConfigurationSchema, captureAiGatewayTaggedLogs } from "../deployment/src/ai-gateway-log-capture.ts";
import { privateDeletionCaptureArtifacts } from "../deployment/src/installation-deletion-capture-command.ts";

try {
  const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" } } });
  if (!values.config || !values.output) throw new Error("Use --config <operator-scope.json> --output <new-private-directory>");
  const configuration = aiGatewayLogCaptureConfigurationSchema.parse(JSON.parse(await readFile(values.config, "utf8")));
  const report = await captureAiGatewayTaggedLogs({ configuration,
    cloudflareToken: process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "",
    artifacts: await privateDeletionCaptureArtifacts(path.resolve(values.output)),
  });
  process.stdout.write(`${JSON.stringify({ scope: report.scope, pages: report.pageReferences.length,
    taggedRecords: report.taggedRecordCount, historicalCoverage: "unknown", submission: null })}\n`);
} catch {
  process.stderr.write("AI Gateway metadata capture did not complete. Check operator scope, API access and pagination, then use a new private output directory. No evidence was submitted and no logs were deleted.\n");
  process.exitCode = 1;
}
