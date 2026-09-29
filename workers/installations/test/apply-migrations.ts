import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";

// SAFETY: vitest.config.ts injects TEST_MIGRATIONS alongside the generated Worker bindings.
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.INSTALLATIONS_DB, testEnv.TEST_MIGRATIONS, "installation_migrations");
