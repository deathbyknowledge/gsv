import { useCallback, useRef, useState } from "preact/hooks";
import type { FilesMutationPending, FilesMutationResult } from "../types";

type RunMutationArgs = {
  pending: FilesMutationPending;
  operation(): Promise<FilesMutationResult>;
  onSuccess(result: FilesMutationResult): void | Promise<void>;
};

export function useFileMutations() {
  const [pending, setPending] = useState<FilesMutationPending | null>(null);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const requestId = useRef(0);

  const runMutation = useCallback(async ({ pending: nextPending, operation, onSuccess }: RunMutationArgs) => {
    const nextRequestId = ++requestId.current;
    setPending(nextPending);
    setStatusText("");
    setErrorText("");
    try {
      const result = await operation();
      if (nextRequestId !== requestId.current) {
        return;
      }
      setStatusText(result.statusText);
      setErrorText(result.errorText);
      if (!result.errorText) {
        await onSuccess(result);
      }
    } catch (error) {
      if (nextRequestId !== requestId.current) {
        return;
      }
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      if (nextRequestId === requestId.current) {
        setPending(null);
      }
    }
  }, []);

  return {
    pending,
    statusText,
    errorText,
    setErrorText,
    runMutation,
  };
}
