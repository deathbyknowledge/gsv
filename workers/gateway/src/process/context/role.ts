import type { ProcessContextRole } from "@humansandmachines/gsv/protocol";

/** Root Markdown is shared; exactly one role directory is included. */
export function contextFileAppliesToRole(name: string, role: ProcessContextRole): boolean {
  const parts = name.split("/");
  return name.endsWith(".md") && (
    parts.length === 1 || (parts.length === 2 && parts[0] === role)
  );
}
