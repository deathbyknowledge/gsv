import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { captureR2MultipartUploads, r2MultipartAbortAuthorizationSchema, r2MultipartCaptureConfigurationSchema } from "../deployment/src/r2-multipart-capture.ts";
import { privateDeletionCaptureArtifacts } from "../deployment/src/installation-deletion-capture-command.ts";

try {
  const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, abort: { type: "boolean" }, authorization: { type: "string" } } });
  if (!values.config || !values.output || Boolean(values.abort) !== Boolean(values.authorization)) {
    throw new Error("Use --config <scope.json> --output <new-private-directory> [--abort --authorization <retired-scope.json>]");
  }
  const configuration = r2MultipartCaptureConfigurationSchema.parse(JSON.parse(await readFile(values.config, "utf8")));
  const abort = values.authorization ? r2MultipartAbortAuthorizationSchema.parse(JSON.parse(await readFile(values.authorization, "utf8"))) : undefined;
  const report = await captureR2MultipartUploads({ configuration, abort,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "", sessionToken: process.env.R2_SESSION_TOKEN },
    artifacts: await privateDeletionCaptureArtifacts(path.resolve(values.output)),
  });
  process.stdout.write(`${JSON.stringify({ scope: report.scope, observedUploads: report.observedUploads,
    abortedUploads: report.abortedUploads, alreadyAbsentUploads: report.alreadyAbsentUploads, remainingUploads: report.remainingUploads,
    historicalCoverage: "unknown", submission: null })}\n`);
} catch {
  process.stderr.write("R2 multipart capture did not complete. Some explicitly authorized aborts may have succeeded. Check the private artifacts and retry with a new output directory; no Accounts evidence was submitted.\n");
  process.exitCode = 1;
}
