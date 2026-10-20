import type { FsReadResult } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { readChatResource } from "../../../services/chat/backend/chatService";
import { useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import { deleteFilesPath, writeFilesPath } from "../../../services/files/backend/filesService";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useDraftGuard } from "../shared/useDraftGuard";
import { useT } from "../../../i18n/locale";

export type FleetFile = { target: string; path: string; name: string };
const EDIT_LIMIT = 1024 * 1024;

export function FileReader({ file, account, onClose, onDirtyChange }: {
  file: FleetFile;
  account?: ConsoleAccount;
  onClose: (deleted?: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const backButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    // Wait for the preview dialog to close in this commit before focusing its replacement.
    queueMicrotask(() => {
      const button = backButton.current;
      if (button && !button.closest("[hidden]")) button.focus({ preventScroll: true });
    });
  }, []);
  const [draft, setDraft] = useState<{ original: string; text: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const readFile = async () => {
    const response = await client.request<FsReadResult>("fs.read", { target: file.target, path: file.path, representation: "reference" });
    await response.body?.stream.cancel();
    const data = response.data;
    if (!data.ok) throw new Error(data.error);
    if (!("resource" in data) || !data.resource) throw new Error(t("fleet.file.noReference"));
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
        throw new Error(t("fleet.file.changed"));
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
      if (!resource) throw new Error(t("fleet.file.referenceUnavailable"));
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
    if (!busy && (!dirty || window.confirm(t("fleet.file.discard")))) {
      void cache.invalidateQueries({ queryKey: ["fleet", "file", file.target, file.path] });
      onClose();
    }
  };
  const error = read.error ?? save.error ?? remove.error ?? download.error;
  return <section class="fleet-file-reader" aria-label={t("fleet.file.label", { name: file.name })} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && draft && !busy && dirty) { event.preventDefault(); save.mutate(draft); }
  }}>
    <header class="file-reader-head">
      <button ref={backButton} class="file-reader-action" type="button" disabled={busy} onClick={close}>{t("fleet.file.back")}</button>
      <span class="file-reader-path">{file.target} · {file.path}</span>
      <div class="file-reader-actions">
        {draft ? <>
          <button class="file-reader-action is-primary" disabled={!connected || busy || !dirty} onClick={() => save.mutate(draft)}>{save.isPending ? t("common.saving") : t("fleet.file.save")}</button>
          <button class="file-reader-action" disabled={busy} onClick={() => { if (!dirty || window.confirm(t("fleet.file.discard"))) { setDraft(null); save.reset(); } }}>{t("common.cancel")}</button>
        </> : <>
          {writable && text !== null && complete && <button class="file-reader-action" disabled={busy} onClick={() => { save.reset(); setDraft({ original: text, text }); }}>{t("common.edit")}</button>}
          {resource && (downloadUrl && !busy ? <a class="file-reader-action" href={downloadUrl} download={file.name}>{t("fleet.file.downloadAgain")}</a> : <button class="file-reader-action" disabled={busy || download.isPending} onClick={() => download.mutate()}>{download.isPending ? t("fleet.file.preparing") : t("fleet.file.download")}</button>)}
          {removable && <button class="file-reader-action is-danger" type="button" disabled={busy} onClick={() => setRemoving(true)}>{t("common.delete")}</button>}
        </>}
      </div>
    </header>
    {error && <p class="error" role="alert">{error.message}</p>}
    {!connected && <p class="note">{t("fleet.file.reconnect")}</p>}
    {removing && <div class="file-reader-confirm"><p>{t("fleet.file.deleteConfirm", { name: file.name, target: file.target })}</p><button class="file-reader-action is-danger" disabled={busy} onClick={() => remove.mutate()}>{t("fleet.file.deletePermanently")}</button><button class="file-reader-action" disabled={busy} onClick={() => setRemoving(false)}>{t("common.cancel")}</button></div>}
    {read.isPending && connected ? <LoadingState variant="panel">{t("fleet.file.reading")}</LoadingState> : draft ? (
      <textarea autoFocus class="file-reader-editor" aria-label={t("fleet.file.text")} spellcheck={false} disabled={busy} value={draft.text} onInput={(event) => setDraft({ ...draft, text: event.currentTarget.value })} />
    ) : <div class="file-reader-content" data-scroll-edge>
      {text !== null ? <pre>{text}</pre> : imageUrl ? <img src={imageUrl} alt={file.name} /> : data ? <p class="note">{t("fleet.file.downloadToOpen")}</p> : null}
      {data?.kind === "text" && data.size > EDIT_LIMIT && <p class="note">{t("fleet.file.tooLarge")}</p>}
    </div>}
  </section>;
}
