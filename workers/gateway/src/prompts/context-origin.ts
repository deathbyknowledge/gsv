import type { InteractionOrigin } from "@humansandmachines/gsv/protocol";
import type { AdapterSurface } from "../adapter-interface";
import type { ReplyDestination } from "../process/internal/schemas";

const PROCESS_REPLY_DESTINATION = {
  key: "process",
  description: "this GSV process",
} as const;

export function formatReplyDestinationForContext(
  origin: InteractionOrigin | undefined,
): ReplyDestination {
  if (!origin) return PROCESS_REPLY_DESTINATION;

  const adapterDestination =
    origin.kind === "adapter" ? origin : origin.kind === "scheduler" ? origin.replyTo : undefined;
  if (adapterDestination) {
    const surface = adapterDestination.surface;
    const surfaceLabel = surface.kind === "dm" ? "direct message" : surface.kind;
    return {
      key: JSON.stringify([
        "adapter",
        adapterDestination.adapter,
        adapterDestination.accountId,
        adapterDestination.actorId,
        surface.kind,
        surface.id,
        surface.threadId ?? "",
      ]),
      description: `this ${titleCase(adapterDestination.adapter)} ${surfaceLabel}`,
    };
  }
  if (origin.kind === "scheduler") return PROCESS_REPLY_DESTINATION;
  if (origin.kind === "client") {
    return {
      key: `client:${origin.connectionId}`,
      description: "this GSV client",
    };
  }
  if (origin.kind === "process") {
    return {
      key: `process:${origin.sourcePid}`,
      description: "the calling GSV process",
    };
  }
  if (origin.kind === "device") {
    return {
      key: `device:${origin.deviceId}`,
      description: "this GSV device client",
    };
  }
  throw new Error("Interaction origin has no reply destination");
}

export function formatInteractionOriginForContext(
  origin: InteractionOrigin | undefined,
): string | null {
  if (!origin) return null;

  if (origin.kind === "adapter") {
    const adapter = titleCase(origin.adapter);
    const surface = formatAdapterSurfaceForContext(origin.surface);
    const actor = origin.surface.kind === "dm" ? null : origin.actorLabel || origin.actorId;
    return [adapter, surface ? ` ${surface}` : "", actor ? ` from ${actor}` : ""].join("");
  }

  if (origin.kind === "client") {
    return formatClientOriginForContext(origin.platform, origin.clientId);
  }

  if (origin.kind === "device") {
    return `device ${origin.deviceId}${origin.cwd ? ` cwd ${origin.cwd}` : ""}`;
  }

  if (origin.kind === "process") {
    return `process ${origin.sourcePid}${origin.uid !== undefined ? ` uid ${origin.uid}` : ""}`;
  }

  if (origin.kind === "scheduler") {
    return `schedule ${origin.scheduleId}`;
  }

  return null;
}

function formatClientOriginForContext(
  platform: string | undefined,
  clientId: string | undefined,
): string {
  if (clientId === "gsv-ui" || platform === "browser" || platform === "web") {
    return "GSV Web Desktop";
  }
  const label = platform || "client";
  return clientId ? `${label} ${clientId}` : label;
}

function formatAdapterSurfaceForContext(surface: AdapterSurface): string {
  const label = surface.name || surface.handle || surface.id;
  if (surface.kind === "dm") {
    return "direct message";
  }
  if (surface.kind === "thread") {
    const thread = surface.threadId ? ` thread ${surface.threadId}` : "";
    return `${surface.kind} ${label}${thread}`;
  }
  return `${surface.kind} ${label}`;
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const known = new Map([
    ["whatsapp", "WhatsApp"],
    ["discord", "Discord"],
    ["gsv", "GSV"],
  ]);
  const mapped = known.get(trimmed.toLowerCase());
  if (mapped) return mapped;
  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}`;
}

