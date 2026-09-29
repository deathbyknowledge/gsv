import { runAdapterSqlMigrations } from "./migrations";
import { ADAPTER_INSTALLATION_V001_STATE } from "./v001_adapter_installation";

export const ADAPTER_INSTALLATION_MIGRATIONS = [ADAPTER_INSTALLATION_V001_STATE] as const;

export function runAdapterInstallationSqlMigrations(storage: DurableObjectStorage): void {
  runAdapterSqlMigrations(storage, "adapter_installation", ADAPTER_INSTALLATION_MIGRATIONS);
}
