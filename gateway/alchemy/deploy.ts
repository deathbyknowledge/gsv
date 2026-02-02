#!/usr/bin/env tsx
/**
 * Deploy GSV Gateway using Alchemy
 * 
 * Usage: npm run deploy:alchemy
 * 
 * Or use the alchemy CLI directly:
 *   npx alchemy deploy alchemy/deploy.ts
 */
import alchemy from "alchemy";
import { createGsvInfra } from "./infra.ts";

const STACK_NAME = "gsv-gateway";
// Use different name from wrangler-deployed worker to avoid conflicts
// In future, we could fully migrate to alchemy and use "gateway"
const WORKER_NAME = "gsv-gateway-alchemy";

const app = await alchemy(STACK_NAME, {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // Store state in .alchemy directory
  stateDir: ".alchemy",
});

const { gateway, storage } = await createGsvInfra({
  name: WORKER_NAME,
  entrypoint: "src/index.ts",
  url: true,
});

console.log("\n✅ Deployed successfully!");
console.log(`   Worker: ${gateway.url}`);
console.log(`   Storage: ${storage.name}`);
