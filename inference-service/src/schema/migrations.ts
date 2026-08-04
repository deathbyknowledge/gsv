import { runSqlMigrations } from "./runner";
import { INFERENCE_V001_INITIAL } from "./v001_initial";

const INFERENCE_SCHEMA_COMPONENT = "managed-inference";
const INFERENCE_MIGRATIONS = [INFERENCE_V001_INITIAL] as const;

export function runInferenceMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(
    storage,
    INFERENCE_SCHEMA_COMPONENT,
    INFERENCE_MIGRATIONS,
  );
}
