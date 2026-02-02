#!/usr/bin/env tsx
/**
 * Destroy GSV Gateway resources using Alchemy
 * 
 * Usage: npm run destroy
 */
import alchemy from "alchemy";
import { createGsvInfra } from "./infra.js";

const STACK_NAME = "gsv-gateway";
const WORKER_NAME = "gateway";

async function main() {
  console.log("🗑️  Destroying GSV Gateway resources...\n");

  const app = await alchemy(STACK_NAME, {
    phase: "destroy",
    stateDir: ".alchemy",
  });

  try {
    await app.run(async () => {
      // Need to "create" resources so alchemy knows what to destroy
      await createGsvInfra({
        name: WORKER_NAME,
        entrypoint: "src/index.ts",
      });
    });

    console.log("\n✅ Resources destroyed!");
  } finally {
    await app.finalize();
  }
}

main().catch((err) => {
  console.error("Destroy failed:", err);
  process.exit(1);
});
