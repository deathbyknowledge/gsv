import type { InstallationExport, InstallationHandoff } from "./types";

export function submitInstallationHandoff(
  handoff: InstallationHandoff,
  documentRef: Document = document,
): void {
  const form = documentRef.createElement("form");
  form.method = "POST";
  form.action = handoff.action;
  form.hidden = true;
  const token = documentRef.createElement("input");
  token.type = "hidden";
  token.name = "token";
  token.value = handoff.token;
  form.append(token);
  documentRef.body.append(form);
  form.submit();
  form.remove();
}

type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<{
  createWritable(): Promise<WritableStream>;
}>;

export async function saveInstallationExport(
  archive: InstallationExport,
  windowRef: Window = window,
): Promise<void> {
  const picker = (windowRef as Window & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (picker && archive.response.body) {
    try {
      const handle = await picker({
        suggestedName: archive.filename,
        types: [{
          description: "GSV installation archive",
          accept: { "application/x-tar": [".tar"] },
        }],
      });
      const writable = await handle.createWritable();
      await archive.response.body.pipeTo(writable);
      return;
    } catch (error) {
      if (!archive.response.body.locked) {
        await archive.response.body.cancel("installation export was not saved")
          .catch(() => undefined);
      }
      throw error;
    }
  }

  const blob = await archive.response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = windowRef.document.createElement("a");
    anchor.href = url;
    anchor.download = archive.filename;
    anchor.hidden = true;
    windowRef.document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
