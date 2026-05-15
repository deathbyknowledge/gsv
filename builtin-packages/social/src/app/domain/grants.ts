import type { EstablishContactArgs } from "../types";
import { SOCIAL_GRANT_OPTIONS } from "../types";

export function defaultGrantSelection(): Set<string> {
  return new Set(SOCIAL_GRANT_OPTIONS.map((option) => option.operation));
}

export function grantsFromSelection(selected: Set<string>): EstablishContactArgs["grants"] {
  return Array.from(selected).map((operation) => ({
    operation: operation as EstablishContactArgs["grants"][number]["operation"],
  }));
}
