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
import {
  KERNEL_V014_ADD_ADAPTER_INGRESS_DELIVERY_ID,
} from "./v014_add_adapter_ingress_delivery_id";
import {
  KERNEL_V015_REMOVE_PACKAGE_RUNTIME,
} from "./v015_remove_package_runtime";
import { KERNEL_V016_REMOVE_PROCESS_CONTEXT } from "./v016_remove_process_context";
import { KERNEL_V017_REORDER_SYSTEM_CONTEXT } from "./v017_reorder_system_context";
import {
  KERNEL_V018_REMOVE_CONVERSATION_REGISTRY,
} from "./v018_remove_conversation_registry";
import { KERNEL_V019_REMOVE_NOTIFICATIONS } from "./v019_remove_notifications";
import { KERNEL_V020_ADD_MAILBOXES } from "./v020_add_mailboxes";
import {
  KERNEL_V021_ISOLATE_MAIL_NOTIFICATIONS,
} from "./v021_isolate_mail_notifications";
import { KERNEL_V022_ADD_OUTBOUND_MAIL } from "./v022_add_outbound_mail";
import {
  KERNEL_V023_ADD_PERSONAL_CONTROLLER_SLOT,
} from "./v023_add_personal_controller_slot";
import {
  KERNEL_V024_ADD_SURFACE_ROUTE_MODES,
} from "./v024_add_surface_route_modes";
import {
  KERNEL_V025_ADD_PRIVATE_ADAPTER_DESTINATIONS,
} from "./v025_add_private_adapter_destinations";
import { KERNEL_V026_ADD_CONVERSATIONS } from "./v026_add_conversations";
import { KERNEL_V027_OWN_DURABLE_TASKS } from "./v027_own_durable_tasks";
import {
  KERNEL_V028_RENAME_HOME_CONVERSATION_TO_SHIP,
} from "./v028_rename_home_conversation_to_ship";
import { KERNEL_V029_ADD_RESPONSIBILITIES } from "./v029_add_responsibilities";

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
  KERNEL_V014_ADD_ADAPTER_INGRESS_DELIVERY_ID,
  KERNEL_V015_REMOVE_PACKAGE_RUNTIME,
  KERNEL_V016_REMOVE_PROCESS_CONTEXT,
  KERNEL_V017_REORDER_SYSTEM_CONTEXT,
  KERNEL_V018_REMOVE_CONVERSATION_REGISTRY,
  KERNEL_V019_REMOVE_NOTIFICATIONS,
  KERNEL_V020_ADD_MAILBOXES,
  KERNEL_V021_ISOLATE_MAIL_NOTIFICATIONS,
  KERNEL_V022_ADD_OUTBOUND_MAIL,
  KERNEL_V023_ADD_PERSONAL_CONTROLLER_SLOT,
  KERNEL_V024_ADD_SURFACE_ROUTE_MODES,
  KERNEL_V025_ADD_PRIVATE_ADAPTER_DESTINATIONS,
  KERNEL_V026_ADD_CONVERSATIONS,
  KERNEL_V027_OWN_DURABLE_TASKS,
  KERNEL_V028_RENAME_HOME_CONVERSATION_TO_SHIP,
  KERNEL_V029_ADD_RESPONSIBILITIES,
];

export function runKernelSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS);
}
