import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { FilesBackend, FilesDevice } from "../types";

export function useDevices(backend: FilesBackend) {
  const [devices, setDevices] = useState<FilesDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const nextRequestId = ++requestId.current;
    setLoading(true);
    try {
      const result = await backend.listDevices();
      if (nextRequestId !== requestId.current) {
        return;
      }
      setDevices(result.devices);
      setErrorText(result.errorText);
    } catch (error) {
      if (nextRequestId !== requestId.current) {
        return;
      }
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      if (nextRequestId === requestId.current) {
        setLoading(false);
      }
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { devices, loading, errorText, refresh };
}
