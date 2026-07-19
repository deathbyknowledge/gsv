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
import { KERNEL_V009_RESTRICT_SYSTEM_BOOTSTRAP } from "./v009_restrict_system_bootstrap";
import { KERNEL_V010_RESTRICT_WILDCARD_CAPABILITY } from "./v010_restrict_wildcard_capability";
import { KERNEL_V011_PRIVATIZE_DEVICE_OWNER_ACCESS } from "./v011_privatize_device_owner_access";
import { KERNEL_V012_RATE_LIMIT_LINK_CHALLENGES } from "./v012_rate_limit_link_challenges";
import { KERNEL_V013_ADD_UNIX_ID_ALLOCATOR } from "./v013_add_unix_id_allocator";
import {
  KERNEL_V014_INTERNALIZE_CONVERSATION_ARCHIVES,
} from "./v014_internalize_conversation_archives";
import { KERNEL_V015_RATE_LIMIT_LOGINS } from "./v015_rate_limit_logins";

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
  KERNEL_V009_RESTRICT_SYSTEM_BOOTSTRAP,
  KERNEL_V010_RESTRICT_WILDCARD_CAPABILITY,
  KERNEL_V011_PRIVATIZE_DEVICE_OWNER_ACCESS,
  KERNEL_V012_RATE_LIMIT_LINK_CHALLENGES,
  KERNEL_V013_ADD_UNIX_ID_ALLOCATOR,
  KERNEL_V014_INTERNALIZE_CONVERSATION_ARCHIVES,
  KERNEL_V015_RATE_LIMIT_LOGINS,
];

export function runKernelSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS);
}
