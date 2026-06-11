import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { detectPathStyle } from "../domain/paths";
import type { FilesBackend, FilesDirectoryLoadResult } from "../types";

function directoryKey(target: string, path: string) {
  return `${target}\u0000${path}`;
}

export function useDirectoryResource(backend: FilesBackend, target: string, path: string) {
  const [data, setData] = useState<FilesDirectoryLoadResult | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const requestId = useRef(0);
  const key = directoryKey(target, path);

  const reload = useCallback(async () => {
    const nextRequestId = ++requestId.current;
    const requestKey = directoryKey(target, path);
    setLoading(true);
    try {
      const result = await backend.loadDirectory({ target, path });
      if (nextRequestId !== requestId.current) {
        return;
      }
      setData(result);
      setLoadedKey(requestKey);
      setErrorText(result.errorText);
    } catch (error) {
      if (nextRequestId !== requestId.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const currentPath = path || ".";
      setData({
        target,
        currentPath,
        pathStyle: detectPathStyle(currentPath),
        directoryResult: { ok: true, path: currentPath, files: [], directories: [] },
        filePath: "",
        errorText: message,
      });
      setLoadedKey(requestKey);
      setErrorText(message);
    } finally {
      if (nextRequestId === requestId.current) {
        setLoading(false);
      }
    }
  }, [backend, path, target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    data,
    key,
    loadedKey,
    loading,
    errorText,
    reload,
  };
}
