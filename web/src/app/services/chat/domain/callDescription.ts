import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { t, type TextKey } from "../../../i18n/locale";

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
  const argument = z.object({ [key]: z.string() }).safeParse(request.args);
  if (!argument.success) return null;
  const value = argument.data[key];
  return value.trim() ? value : null;
}

/** Each verb phrase alone, in the cloud home, and on any other place. */
type PlacedCall = readonly [alone: TextKey, inHome: TextKey, onPlace: TextKey];

const PLACED_CALLS = new Map<string, PlacedCall>([
  ["shell.exec", ["chat.call.shell", "chat.call.shellIn", "chat.call.shellOn"]],
  ["fs.read", ["chat.call.read", "chat.call.readIn", "chat.call.readOn"]],
  ["fs.write", ["chat.call.write", "chat.call.writeIn", "chat.call.writeOn"]],
  ["fs.edit", ["chat.call.edit", "chat.call.editIn", "chat.call.editOn"]],
  ["fs.delete", ["chat.call.delete", "chat.call.deleteIn", "chat.call.deleteOn"]],
  ["fs.search", ["chat.call.search", "chat.call.searchIn", "chat.call.searchOn"]],
  ["net.fetch", ["chat.call.fetch", "chat.call.fetchIn", "chat.call.fetchOn"]],
]);
const TOOL_CALL: PlacedCall = ["chat.call.tool", "chat.call.toolIn", "chat.call.toolOn"];

/** A bare verb phrase for a request the model did not explain, in the shape the purpose would take. */
export function describeCall(request: DescribedCall, place?: string): string {
  switch (request.syscall) {
    case "codemode.exec":
    case "codemode.run": return t("chat.call.code");
    case "atproto.write": return t("chat.call.publish");
    case "sched.add": return t("chat.call.schedule");
    case "mail.send": {
      const to = callArgumentText(request, "to");
      const subject = callArgumentText(request, "subject");
      if (to && subject) return t("chat.call.mailAbout", { to, subject });
      if (to) return t("chat.call.mailTo", { to });
      if (callArgumentText(request, "replyToMessageId")) return t("chat.call.mailReply");
      return t("chat.call.mail");
    }
    default: {
      const [alone, inHome, onPlace] = PLACED_CALLS.get(request.syscall ?? "") ?? TOOL_CALL;
      return t(!place ? alone : request.target === "gsv" ? inHome : onPlace, { tool: request.toolName, place: place ?? "" });
    }
  }
}
