import { readFile, rename, writeFile } from "node:fs/promises";
import type { Context } from "@earendil-works/pi-ai";
import { completeWithCustomProvider } from "../../workers/gateway/src/inference/custom-provider";
import { parseGsvSurfaceScenario } from "./scenario";
import type {
  GsvSurfaceArtifact,
  GsvSurfacePartialArtifact,
} from "./schema";
import { runGsvSurfaceScenario } from "./surface";

type CliArgs = {
  scenario: string;
  artifact: string;
  partialArtifact: string;
};

const args = parseArgs(process.argv.slice(2));
const endpoint = requiredEnv("GSV_BENCH_MODEL_ENDPOINT");
const secret = requiredEnv("GSV_BENCH_MODEL_SECRET");
const model = requiredEnv("GSV_BENCH_MODEL");
const scenario = parseGsvSurfaceScenario(
  JSON.parse(await readFile(args.scenario, "utf8")),
);

const artifact = await runGsvSurfaceScenario(
  scenario,
  async (context: Context) =>
    completeWithCustomProvider({
      provider: "custom",
      model,
      apiKey: secret,
      baseUrl: endpoint,
      providerStyle: "openai-chat-completions",
      contextWindowTokens: 128_000,
      maxTokens: 2_048,
      context,
      options: {
        maxTokens: 2_048,
        timeoutMs: 120_000,
      },
    }),
  async (checkpoint) => writeJsonAtomically(args.partialArtifact, checkpoint),
);

await writeJsonAtomically(args.artifact, artifact);
process.stdout.write(`${JSON.stringify({
  scenarioId: artifact.scenarioId,
  status: artifact.status,
  semanticEvents: artifact.log.length,
})}\n`);

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: cli.ts --scenario PATH --artifact PATH --partial-artifact PATH",
      );
    }
    values.set(key.slice(2), value);
  }
  const scenario = values.get("scenario");
  const artifact = values.get("artifact");
  const partialArtifact = values.get("partial-artifact");
  if (!scenario || !artifact || !partialArtifact) {
    throw new Error(
      "Usage: cli.ts --scenario PATH --artifact PATH --partial-artifact PATH",
    );
  }
  return { scenario, artifact, partialArtifact };
}

type PersistedGsvArtifact = GsvSurfaceArtifact | GsvSurfacePartialArtifact;

async function writeJsonAtomically(
  path: string,
  value: PersistedGsvArtifact,
): Promise<void> {
  const temporary = path + ".tmp";
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
