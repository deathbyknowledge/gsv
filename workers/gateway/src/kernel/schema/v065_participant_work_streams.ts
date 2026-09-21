import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V065_PARTICIPANT_WORK_STREAMS: SqlMigration = {
  id: 65,
  name: "participant_work_streams",
  statements: ["ALTER TABLE federation_requests ADD COLUMN work_json TEXT"],
};
