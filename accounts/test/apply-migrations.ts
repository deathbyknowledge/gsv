import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";

// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.ACCOUNT_DB, testEnv.TEST_MIGRATIONS);
