import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { assertUpgradeEnvironment, upgradeFixturePlan, upgradeFixtureSchema, type UpgradePhase } from "./plan.ts";
import { legacyUpgradeComposition } from "./composition.ts";
import { assertUpgradeBuildReceipt } from "./receipt.ts";

const file = process.env.GSV_UPGRADE_FIXTURE_FILE;
if (!file) throw new Error("GSV_UPGRADE_FIXTURE_FILE is required; this fixture has no implicit deployment target");
const input = upgradeFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const phase: UpgradePhase = process.env.GSV_UPGRADE_PHASE === "legacy" ? "legacy"
  : process.env.GSV_UPGRADE_PHASE === "handoff" ? "handoff"
    : process.env.GSV_UPGRADE_PHASE === "current" ? "current"
      : (() => { throw new Error("GSV_UPGRADE_PHASE must be legacy, handoff or current"); })();
export default Alchemy.Stack(upgradeFixturePlan(input).stack, { providers: Cloudflare.providers(), state: Cloudflare.state() }, Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  assertUpgradeEnvironment(input, process.env, stage);
  assertUpgradeBuildReceipt(input, phase === "current" ? "current" : "legacy");
  return yield* legacyUpgradeComposition(input, phase);
}));
