import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V014_ADD_ADAPTER_INGRESS_DELIVERY_ID: SqlMigration = {
  id: 14,
  name: "add_adapter_ingress_delivery_id",
  statements: [
    `
      ALTER TABLE adapter_ingress_receipts
        ADD COLUMN provider_delivery_id TEXT
    `,
  ],
};
