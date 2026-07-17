import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { KERNEL_V001_INITIAL_SCHEMA } from "./v001_initial";
import { KERNEL_V002_REMOVE_DEVICE_LIFECYCLE } from "./v002_remove_device_lifecycle";
import { KERNEL_V003_REMOVE_PROCESS_MOUNTS } from "./v003_remove_process_mounts";
import { KERNEL_V004_REMOVE_LEGACY_SIGNAL_WATCHES } from "./v004_remove_legacy_signal_watches";
import { KERNEL_V005_ADD_ADAPTER_STATUS_OWNER } from "./v005_add_adapter_status_owner";
import { KERNEL_V006_ADD_IPC_DELIVERY_STATE } from "./v006_add_ipc_delivery_state";
import { KERNEL_V007_REMOVE_CLI_MIRROR } from "./v007_remove_cli_mirror";
import {
  KERNEL_V008_BIND_ROUTES_TO_DRIVER_CONNECTIONS,
} from "./v008_bind_routes_to_driver_connections";
import { KERNEL_V009_BIND_RUN_REPLY_ROUTES } from "./v009_bind_run_reply_routes";
import {
  KERNEL_V010_SCOPE_ADAPTER_DESTINATIONS,
} from "./v010_scope_adapter_destinations";
import {
  KERNEL_V011_ADD_SCHEDULE_OCCURRENCE_ID,
} from "./v011_add_schedule_occurrence_id";
import {
  KERNEL_V012_ADD_SCHEDULE_ATTEMPT_COUNT,
} from "./v012_add_schedule_attempt_count";
import {
  KERNEL_V013_ADD_ADAPTER_INGRESS_RECEIPTS,
} from "./v013_add_adapter_ingress_receipts";

// Used by Kernel DO startup before the individual stores initialize.
export const KERNEL_SCHEMA_COMPONENT = "kernel";

export const KERNEL_MIGRATIONS: readonly SqlMigration[] = [
  KERNEL_V001_INITIAL_SCHEMA,
  KERNEL_V002_REMOVE_DEVICE_LIFECYCLE,
  KERNEL_V003_REMOVE_PROCESS_MOUNTS,
  KERNEL_V004_REMOVE_LEGACY_SIGNAL_WATCHES,
  KERNEL_V005_ADD_ADAPTER_STATUS_OWNER,
  KERNEL_V006_ADD_IPC_DELIVERY_STATE,
  KERNEL_V007_REMOVE_CLI_MIRROR,
  KERNEL_V008_BIND_ROUTES_TO_DRIVER_CONNECTIONS,
  KERNEL_V009_BIND_RUN_REPLY_ROUTES,
  KERNEL_V010_SCOPE_ADAPTER_DESTINATIONS,
  KERNEL_V011_ADD_SCHEDULE_OCCURRENCE_ID,
  KERNEL_V012_ADD_SCHEDULE_ATTEMPT_COUNT,
  KERNEL_V013_ADD_ADAPTER_INGRESS_RECEIPTS,
];

export function runKernelSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS);
}
