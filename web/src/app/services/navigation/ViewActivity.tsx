import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useLayoutEffect, useRef, useState, type StateUpdater } from "preact/hooks";

const ViewActivity = createContext(true);

export function useViewActive(): boolean {
  return useContext(ViewActivity);
}

/** Open each view once per signed-in session; keep its local state while it is away. */
export function RetainedView({ active, children }: { active: boolean; children: ComponentChildren }) {
  const visited = useRef(active);
  const element = useRef<HTMLDivElement>(null);
  visited.current ||= active;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!active && focused instanceof HTMLElement && element.current?.contains(focused)) focused.blur();
  }, [active]);
  return <div class="instrument-view" ref={element} hidden={!active} inert={!active}>
    {visited.current && <ViewActivity.Provider value={active}>{children}</ViewActivity.Provider>}
  </div>;
}

function isUpdater<T>(change: StateUpdater<T>): change is (previous: T) => T {
  return typeof change === "function";
}

/** Merge live state while away, publishing its latest snapshot when the view returns. */
export function useViewSnapshot<T>(initial: T) {
  const active = useViewActive();
  const visible = useRef(active);
  visible.current = active;
  const latest = useRef(initial);
  const [snapshot, publish] = useState(() => initial);
  const update = useCallback((change: StateUpdater<T>) => {
    const next = isUpdater(change) ? change(latest.current) : change;
    latest.current = next;
    if (visible.current) publish(() => next);
  }, []);
  useLayoutEffect(() => { if (active) publish(() => latest.current); }, [active]);
  return [active ? latest.current : snapshot, update, latest] as const;
}
