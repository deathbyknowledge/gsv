import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { FilesBackend, FilesSearchLoadResult } from "../types";

function searchKey(target: string, path: string, q: string) {
  return `${target}\u0000${path}\u0000${q}`;
}

export function useSearchResource(backend: FilesBackend, target: string, path: string, q: string, enabled: boolean) {
  const [data, setData] = useState<FilesSearchLoadResult | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");
  const requestId = useRef(0);
  const trimmedQuery = q.trim();
  const key = enabled && trimmedQuery ? searchKey(target, path, trimmedQuery) : "";

  const reload = useCallback(async () => {
    if (!enabled || !trimmedQuery) {
      requestId.current += 1;
      setData(null);
      setLoadedKey("");
      setErrorText("");
      setLoading(false);
      return;
    }

    const nextRequestId = ++requestId.current;
    const requestKey = searchKey(target, path, trimmedQuery);
    setLoading(true);
    try {
      const result = await backend.searchFiles({ target, path, q: trimmedQuery });
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
        path,
        q: trimmedQuery,
        searchResult: { ok: true, matches: [], truncated: false },
        errorText: message,
      });
      setLoadedKey(requestKey);
      setErrorText(message);
    } finally {
      if (nextRequestId === requestId.current) {
        setLoading(false);
      }
    }
  }, [backend, enabled, path, target, trimmedQuery]);

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
