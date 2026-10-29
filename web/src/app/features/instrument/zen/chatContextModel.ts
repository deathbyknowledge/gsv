export type ActivityRow = `work:${string}` | `routine:${string}`;
export type ActivityRequest = { row?: ActivityRow; processId?: string; tab?: "ongoing" | "routines" | "history" };
import type { FleetRow } from "../Instrument";
import { fileRowLocation, type FileRowLocation } from "../fleet/fleetModel";

export type ChatContext =
  | { kind: "activity"; request?: ActivityRequest }
  | { kind: "person"; url?: string }
  | { kind: "files" }
  | { kind: "connect" }
  | { kind: "path"; location: FileRowLocation };

/** A path Ship wrote opens over the chat; every other reference is Work's. */
export function chatLinkContext(row: FleetRow): ChatContext | null {
  const location = fileRowLocation(row);
  return location ? { kind: "path", location } : null;
}
