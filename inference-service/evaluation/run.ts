import { createDeepSeekProvider } from "../src/providers/deepseek";
import {
  MINIMUM_OFFICIAL_EVALUATION_REPETITIONS,
  runManagedInferenceEvaluation,
  type EvaluationOptions,
} from "../src/evaluation/runner";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stderr: { write(value: string): void };
  stdout: { write(value: string): void };
  exit(code: number): never;
  exitCode?: number;
};

const options = parseOptions(process.argv.slice(2));
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write(
    "DEEPSEEK_API_KEY must be injected through the environment; command-line credentials are not accepted.\n",
  );
  process.exit(2);
}

const report = await runManagedInferenceEvaluation(
  createDeepSeekProvider(apiKey),
  options,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gate.passed) process.exitCode = 1;

function parseOptions(args: string[]): EvaluationOptions {
  let repetitions = MINIMUM_OFFICIAL_EVALUATION_REPETITIONS;
  let timeoutMs = 60_000;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repetitions") {
      repetitions = boundedPositiveInteger(args[++index], "--repetitions", 10);
      continue;
    }
    if (argument === "--timeout-ms") {
      timeoutMs = boundedPositiveInteger(args[++index], "--timeout-ms", 180_000);
      continue;
    }
    throw new Error(`Unsupported evaluation option: ${argument}`);
  }
  return { repetitions, timeoutMs };
}

function boundedPositiveInteger(
  value: string | undefined,
  option: string,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${option} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}
