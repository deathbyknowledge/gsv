import { runSqlMigrations } from "./runner";
import { INFERENCE_V001_INITIAL } from "./v001_initial";
import { INFERENCE_V002_ADD_MANAGED_LIFECYCLE } from "./v002_add_managed_lifecycle";

const INFERENCE_SCHEMA_COMPONENT = "managed-inference";
const INFERENCE_MIGRATIONS = [
  INFERENCE_V001_INITIAL,
  INFERENCE_V002_ADD_MANAGED_LIFECYCLE,
] as const;

export function runInferenceMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(
    storage,
    INFERENCE_SCHEMA_COMPONENT,
    INFERENCE_MIGRATIONS,
  );
}
