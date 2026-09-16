import type { JsonValue } from "@humansandmachines/gsv/protocol";

type DescribedCall = {
  toolName: string;
  syscall: string | null;
  target?: string | null;
  args?: JsonValue;
};

export function normalizeCallPurpose(purpose: string | null | undefined): string | undefined {
  return purpose?.replace(/\s+/g, " ").trim() || undefined;
}

export function callArgumentText(request: Pick<DescribedCall, "args">, key: string): string | null {
  const args = request.args;
  const value = args && typeof args === "object" && !Array.isArray(args) ? args[key] : undefined;
  return typeof value === "string" && value.trim() ? value : null;
}

/** A bare verb phrase for a request the model did not explain, in the shape the purpose would take. */
export function describeCall(request: DescribedCall, place?: string): string {
  const where = place ? ` ${request.target === "gsv" ? "in" : "on"} ${place}` : "";
  switch (request.syscall) {
    case "shell.exec": return `run a command${where}`;
    case "fs.read": return `read a file${where}`;
    case "fs.write": return `write a file${where}`;
    case "fs.edit": return `edit a file${where}`;
    case "fs.delete": return `delete a file${where}`;
    case "fs.search": return `search files${where}`;
    case "net.fetch": return `fetch a web address${where}`;
    case "codemode.exec":
    case "codemode.run": return "run code";
    case "mail.send": {
      const to = callArgumentText(request, "to");
      const subject = callArgumentText(request, "subject");
      if (to && subject) return `send an email to ${to} about ${subject}`;
      if (to) return `send an email to ${to}`;
      if (callArgumentText(request, "replyToMessageId")) return "reply to an email";
      return "send an email";
    }
    default: return `use ${request.toolName}${where}`;
  }
}
