import type {
  SpaceGsvContactRecord,
  SpaceGsvPackageRecord,
  SpaceGsvPackageReleaseRecord,
  SpaceGsvRecordReference,
  SpaceGsvVouchRecord,
} from "@gsv/protocol/syscalls/social";

export function formatShortDate(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatRelativeAge(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  const delta = Date.now() - date.valueOf();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (Math.abs(delta) < hour) {
    return `${Math.max(1, Math.round(Math.abs(delta) / minute))}m`;
  }
  if (Math.abs(delta) < day) {
    return `${Math.round(Math.abs(delta) / hour)}h`;
  }
  return `${Math.round(Math.abs(delta) / day)}d`;
}

export function formatPackageSource(record: SpaceGsvPackageRecord): string {
  const source = record.source;
  return source?.repo ?? source?.uri ?? source?.subdir ?? source?.ref ?? record.homepage ?? "GSV package";
}

export function formatPackageRelease(record: SpaceGsvPackageReleaseRecord): string {
  return record.title ?? record.version;
}

export function formatContactSubject(record: SpaceGsvContactRecord): string {
  return record.label ?? record.subject.handle ?? record.subject.uri ?? record.subject.did;
}

export function formatVouchSubject(record: SpaceGsvVouchRecord): string {
  return record.note ?? formatRecordReference(record.subject);
}

export function formatRecordReference(reference: SpaceGsvRecordReference): string {
  return reference.cid ? `${reference.uri} (${compactId(reference.cid)})` : reference.uri;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function plainObjectEntries(value: unknown): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>);
}

export function formatStructuredValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (typeof value === "object") {
    return "object";
  }
  return "";
}

export function compactId(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
