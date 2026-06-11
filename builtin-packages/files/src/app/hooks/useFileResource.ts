import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { FilesBackend, FilesFileLoadResult } from "../types";

function fileKey(target: string, path: string) {
  return `${target}\u0000${path}`;
}

export function useFileResource(backend: FilesBackend, target: string, path: string, enabled: boolean) {
  const [data, setData] = useState<FilesFileLoadResult | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");
  const requestId = useRef(0);
  const key = enabled ? fileKey(target, path) : "";

  const reload = useCallback(async () => {
    if (!enabled || !path) {
      requestId.current += 1;
      setData(null);
      setLoadedKey("");
      setErrorText("");
      setLoading(false);
      return;
    }

    const nextRequestId = ++requestId.current;
    const requestKey = fileKey(target, path);
    setLoading(true);
    try {
      const result = await backend.loadFile({ target, path });
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
      setData({
        target,
        filePath: "",
        fileResult: null,
        directoryPath: "",
        directoryResult: null,
        pathStyle: "relative",
        errorText: message,
      });
      setLoadedKey(requestKey);
      setErrorText(message);
    } finally {
      if (nextRequestId === requestId.current) {
        setLoading(false);
      }
    }
  }, [backend, enabled, path, target]);

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
