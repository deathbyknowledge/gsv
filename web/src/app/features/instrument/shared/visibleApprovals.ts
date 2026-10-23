import { useEffect, useState } from "preact/hooks";

/** Approval requests whose card is on screen in the active view; the corner toast leaves those to their card. */
const visible = new Map<string, number>();
const listeners = new Set<() => void>();

export function showApprovalCard(requestId: string): () => void {
  visible.set(requestId, (visible.get(requestId) ?? 0) + 1);
  for (const listener of listeners) listener();
  return () => {
    const count = (visible.get(requestId) ?? 1) - 1;
    if (count > 0) visible.set(requestId, count);
    else visible.delete(requestId);
    for (const listener of listeners) listener();
  };
}

export function useVisibleApprovals(): ReadonlySet<string> {
  const [snapshot, setSnapshot] = useState<ReadonlySet<string>>(() => new Set(visible.keys()));
  useEffect(() => {
    const update = () => setSnapshot(new Set(visible.keys()));
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);
  return snapshot;
}
