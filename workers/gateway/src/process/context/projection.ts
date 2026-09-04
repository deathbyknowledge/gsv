import type {
  AiContextResult, AiSkillIndexMode, AiToolsTarget, JsonObject, JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { aiToolsDeviceSchema } from "../internal/schemas";

const skillSchema = z.object({
  id: z.string(),
  description: z.string(),
});
const contextProjectionSchema = z.object({
  version: z.literal(1),
  runtime: z.object({
    date: z.string(),
    timezone: z.string(),
  }),
  targets: z.array(aiToolsDeviceSchema),
  mcpServers: z.array(z.string()),
  skills: z.object({
    mode: z.enum(["summary", "names", "off"]),
    entries: z.array(skillSchema),
  }),
});

export type ContextProjection = z.infer<typeof contextProjectionSchema>;
export type ContextProjectionTarget = ContextProjection["targets"][number];
type ContextProjectionSkill = ContextProjection["skills"]["entries"][number];

export function createContextProjection(
  snapshot: AiContextResult,
  now = new Date(),
  fallbackSkills?: ContextProjection["skills"],
): ContextProjection {
  const timezone = normalizeContextTimezone(snapshot.system.timezone);
  return {
    version: 1,
    runtime: {
      date: formatContextDate(now, timezone),
      timezone,
    },
    targets: normalizeTargets(snapshot.targets),
    mcpServers: normalizeStringSet(snapshot.mcpServers),
    skills: normalizeSkillProjection(snapshot, fallbackSkills),
  };
}

export function parseContextProjection(
  value: JsonValue | undefined,
): ContextProjection | null {
  const result = contextProjectionSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function contextProjectionFromManifest(
  manifest: JsonObject,
): ContextProjection | null {
  if (manifest.version !== 2) return null;
  return parseContextProjection(manifest.contextProjection);
}

export function contextProjectionsEqual(
  left: ContextProjection,
  right: ContextProjection,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeContextTimezone(value: string | undefined): string {
  const candidate = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return "UTC";
  }
}

function formatContextDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function normalizeTargets(devices: AiToolsTarget[]): ContextProjectionTarget[] {
  return devices
    .map((device): ContextProjectionTarget => {
      const target: ContextProjectionTarget = {
        id: normalizeLine(device.id),
        implements: normalizeStringSet(device.implements),
      };
      const label = normalizeOptionalLine(device.label);
      const description = normalizeOptionalLine(device.description);
      const platform = normalizeOptionalLine(device.platform);
      if (label) target.label = label;
      if (description) target.description = description;
      if (platform) target.platform = platform;
      return target;
    })
    .filter((target) => target.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeSkills(
  entries: NonNullable<AiContextResult["skillIndex"]>,
  mode: AiSkillIndexMode,
): ContextProjectionSkill[] {
  if (mode === "off") return [];
  return entries
    .map((entry): ContextProjectionSkill => ({
      id: normalizeLine(entry.id),
      description: mode === "summary" ? normalizeLine(entry.description) : "",
    }))
    .filter((entry) => entry.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeSkillProjection(
  snapshot: AiContextResult,
  fallback: ContextProjection["skills"] | undefined,
): ContextProjection["skills"] {
  if (snapshot.skillIndex === undefined && fallback) {
    return {
      mode: fallback.mode,
      entries: fallback.entries.map((entry) => ({ ...entry })),
    };
  }
  const mode = normalizeSkillIndexMode(snapshot.skillIndexMode);
  return {
    mode,
    entries: normalizeSkills(snapshot.skillIndex ?? [], mode),
  };
}

function normalizeStringSet(values: string[]): string[] {
  return [...new Set(values.map(normalizeLine).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeLine(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeOptionalLine(value: string | undefined): string | undefined {
  const normalized = value === undefined ? "" : normalizeLine(value);
  return normalized || undefined;
}

function normalizeSkillIndexMode(value: AiSkillIndexMode): AiSkillIndexMode {
  return value === "names" || value === "off" ? value : "summary";
}
