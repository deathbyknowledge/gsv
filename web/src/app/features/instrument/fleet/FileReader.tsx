import type { FsReadResult } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useRef, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { readChatResource } from "../../chat/backend/chatService";
import { useMediaObjectUrl } from "../../chat/hooks/useChatMediaSource";
import { deleteFilesPath, writeFilesPath } from "../../files/backend/filesService";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { useDraftGuard } from "../shared/useDraftGuard";

export type FleetFile = { target: string; path: string; name: string };
const EDIT_LIMIT = 1024 * 1024;

export function FileReader({ file, account, onClose, onDirtyChange }: {
  file: FleetFile;
  account?: ConsoleAccount;
  onClose: (deleted?: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<{ original: string; text: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const readFile = async () => {
    const response = await client.request<FsReadResult>("fs.read", { target: file.target, path: file.path, representation: "reference" });
    await response.body?.stream.cancel();
    const data = response.data;
    if (!data.ok) throw new Error(data.error);
    if (!("resource" in data) || !data.resource) throw new Error("This target did not provide a downloadable file reference.");
    const canDisplay = data.kind === "text" ? data.size <= EDIT_LIMIT : data.kind === "image" && data.size <= 8 * EDIT_LIMIT;
    const blob = canDisplay ? (await readChatResource(client, data.resource)).blob : undefined;
    const content = data.kind === "text" && blob ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer()) : null;
    return { ...data, content, blob: data.kind === "image" ? blob : undefined };
  };
  const queryKey = ["instrument", "file-reader", file.target, file.path];
  const read = useQuery({ queryKey, queryFn: readFile, enabled: connected, refetchOnMount: "always" });
  const data = read.data;
  const text = data?.content ?? null;
  const imageUrl = useMediaObjectUrl(data?.blob);
  const resource = data?.resource;
  const complete = data && !data.truncated && data.size <= EDIT_LIMIT;
  const writable = Boolean(!read.isFetching && account && canConfigure(account, "fs.write"));
  const removable = Boolean(account && canConfigure(account, "fs.delete"));
  const refresh = async () => {
    await cache.cancelQueries({ queryKey: ["fleet", "file", file.target, file.path] });
    await cache.invalidateQueries({ queryKey: ["fleet", "file", file.target, file.path] });
    await cache.invalidateQueries({ queryKey: ["fleet", "files", file.target] });
  };
  const save = useMutation({
    mutationFn: async (value: { original: string; text: string }) => {
      const current = await readFile();
      if (current.kind !== "text" || current.content !== value.original) {
        throw new Error("This file changed since you opened it. Your draft is kept; reopen the latest file before saving.");
      }
      const result = await writeFilesPath(client, { ...file, content: value.text });
      if (!result.ok) throw new Error(result.error);
      return value.text;
    },
    onSuccess: async (content) => {
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(queryKey, data && "kind" in data ? { ...data, content, size: new TextEncoder().encode(content).length } : undefined);
      setDraft(null);
      await refresh();
      await cache.invalidateQueries({ queryKey });
      download.reset();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const result = await deleteFilesPath(client, file);
      if (!result.ok) throw new Error(result.error);
    },
    onSuccess: async () => { await refresh(); onClose(true); },
  });
  const download = useMutation({
    mutationFn: async () => {
      if (!resource) throw new Error("A downloadable file reference is unavailable.");
      return (await readChatResource(client, resource)).blob;
    },
  });
  const downloadUrl = useMediaObjectUrl(download.data);
  const offeredDownload = useRef("");
  useEffect(() => {
    if (!downloadUrl || downloadUrl === offeredDownload.current) return;
    offeredDownload.current = downloadUrl;
    const link = document.createElement("a"); link.href = downloadUrl; link.download = file.name;
    document.body.append(link); link.click(); link.remove();
  }, [downloadUrl, file.name]);
  const busy = save.isPending || remove.isPending;
  const dirty = Boolean(draft && draft.text !== draft.original);
  useDraftGuard(dirty || busy, onDirtyChange);
  const close = () => {
    if (!busy && (!dirty || window.confirm("Discard your unsaved file changes?"))) {
      void cache.invalidateQueries({ queryKey: ["fleet", "file", file.target, file.path] });
      onClose();
    }
  };
  const error = read.error ?? save.error ?? remove.error ?? download.error;
  return <section class="fleet-file-reader" aria-label={`File: ${file.name}`} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && draft && !busy && dirty) { event.preventDefault(); save.mutate(draft); }
  }}>
    <header class="file-reader-head">
      <button class="file-reader-action" type="button" disabled={busy} onClick={close}>← back to fleet</button>
      <span class="file-reader-path">{file.target} · {file.path}</span>
      <div class="file-reader-actions">
        {draft ? <>
          <button class="file-reader-action is-primary" disabled={!connected || busy || !dirty} onClick={() => save.mutate(draft)}>{save.isPending ? "saving…" : "save"}</button>
          <button class="file-reader-action" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard your unsaved file changes?")) { setDraft(null); save.reset(); } }}>cancel</button>
        </> : <>
          {writable && text !== null && complete && <button class="file-reader-action" disabled={busy} onClick={() => { save.reset(); setDraft({ original: text, text }); }}>edit</button>}
          {resource && (downloadUrl && !busy ? <a class="file-reader-action" href={downloadUrl} download={file.name}>download again</a> : <button class="file-reader-action" disabled={busy || download.isPending} onClick={() => download.mutate()}>{download.isPending ? "preparing…" : "download"}</button>)}
          {removable && <button class="file-reader-action is-danger" type="button" disabled={busy} onClick={() => setRemoving(true)}>delete</button>}
        </>}
      </div>
    </header>
    {error && <p class="error" role="alert">{error.message}</p>}
    {!connected && <p class="note">Reconnect to read or save this file.</p>}
    {removing && <div class="file-reader-confirm"><p>Delete {file.name} from {file.target}?</p><button class="file-reader-action is-danger" disabled={busy} onClick={() => remove.mutate()}>delete permanently</button><button class="file-reader-action" disabled={busy} onClick={() => setRemoving(false)}>cancel</button></div>}
    {read.isPending && connected ? <LoadingState variant="panel">Reading file…</LoadingState> : draft ? (
      <textarea autoFocus class="file-reader-editor" aria-label="File text" spellcheck={false} disabled={busy} value={draft.text} onInput={(event) => setDraft({ ...draft, text: event.currentTarget.value })} />
    ) : <div class="file-reader-content">
      {text !== null ? <pre>{text}</pre> : imageUrl ? <img src={imageUrl} alt={file.name} /> : data ? <p class="note">Download this file to open it.</p> : null}
      {data?.kind === "text" && data.size > EDIT_LIMIT && <p class="note">Files larger than 1 MiB open as downloads.</p>}
    </div>}
  </section>;
}
