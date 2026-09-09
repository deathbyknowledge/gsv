import type { GSVClient } from "@humansandmachines/gsv/client";
import type { FsWriteArgs } from "@humansandmachines/gsv/protocol";
import { requestFsRead } from "../../../services/gateway/fsRead";
import { instructionPath } from "./settingsModel";
import { z } from "zod";

const writeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string(), size: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export async function listInstructions(client: Pick<GSVClient, "request">): Promise<string[]> {
  const result = await requestFsRead(client, { target: "gsv", path: "~/context.d" });
  if (!result.ok) throw new Error(result.error);
  if (!("files" in result)) throw new Error("Your instructions path is not a folder");
  return result.files.filter((name) => name.endsWith(".md")).sort();
}

export async function readInstruction(client: Pick<GSVClient, "request">, name: string): Promise<string> {
  const result = await requestFsRead(client, { target: "gsv", path: instructionPath(name) });
  if (!result.ok) throw new Error(result.error);
  if (!("kind" in result) || result.kind !== "text") throw new Error("This instruction file is not readable text");
  if (result.truncated) throw new Error("This instruction file is too large to edit here without losing content");
  return result.content;
}

export async function saveInstruction(client: Pick<GSVClient, "call">, name: string, content: string): Promise<void> {
  const args: FsWriteArgs = { path: instructionPath(name), content };
  const result = writeResultSchema.parse(await client.call("fs.write", args));
  if (!result.ok) throw new Error(result.error);
}
