import type { GSVClient } from "@humansandmachines/gsv/client";
import type { FsWriteArgs } from "@humansandmachines/gsv/protocol";
import { requestFsRead } from "../../../services/gateway/fsRead";
import { instructionPath, newInstructionName } from "./settingsModel";
import { z } from "zod";

const writeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string(), size: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const deleteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

async function instructionDirectory(client: Pick<GSVClient, "request">): Promise<{ files: string[]; directories: string[] }> {
  const result = await requestFsRead(client, { target: "gsv", path: "~/context.d" });
  if (!result.ok) {
    if (/^ENOENT\b/.test(result.error)) return { files: [], directories: [] };
    throw new Error(result.error);
  }
  if (!("files" in result)) throw new Error("Your instructions path is not a folder");
  return result;
}

export async function listInstructions(client: Pick<GSVClient, "request">): Promise<string[]> {
  const result = await instructionDirectory(client);
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

export async function createInstruction(client: Pick<GSVClient, "call" | "request">, value: string, content: string): Promise<string> {
  const name = newInstructionName(value);
  const directory = await instructionDirectory(client);
  if (directory.files.includes(name) || directory.directories.includes(name)) {
    throw new Error(`“${name}” already exists. Choose a different name.`);
  }
  await saveInstruction(client, name, content);
  return name;
}

export async function deleteInstruction(client: Pick<GSVClient, "call" | "request">, name: string): Promise<void> {
  const path = instructionPath(name);
  const directory = await instructionDirectory(client);
  if (!directory.files.includes(name)) throw new Error("This instruction file is no longer available.");
  const result = deleteResultSchema.parse(await client.call("fs.delete", { path }));
  if (!result.ok) throw new Error(result.error);
}
