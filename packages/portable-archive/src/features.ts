/**
 * Canonical requiredSchemaFeatures tokens for Portable Archive v1 body codecs.
 *
 * A token's presence here reserves its protocol spelling. An exporter must not
 * advertise a token until it actually emits that codec, and an importer must
 * still fail closed unless it implements the complete corresponding schema.
 */
export const DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE =
  "gsv-do-logical-snapshot-v1" as const;
export const RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE =
  "gsv-ripgit-logical-snapshot-v1" as const;
export const R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE =
  "gsv-r2-logical-snapshot-v1" as const;
export const WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE =
  "gsv-workers-kv-logical-snapshot-v1" as const;

export const PORTABLE_ARCHIVE_V1_SCHEMA_FEATURES = Object.freeze([
  DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
] as const);

export type PortableArchiveV1SchemaFeature =
  (typeof PORTABLE_ARCHIVE_V1_SCHEMA_FEATURES)[number];
