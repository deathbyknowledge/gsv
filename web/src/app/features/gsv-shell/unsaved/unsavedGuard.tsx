import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";

/**
 * Shell-wide unsaved-changes guard.
 *
 * Screens that hold editable state register a `isDirty` probe via
 * {@link useUnsavedGuard}. Any navigation that would unmount the active screen
 * (the top-right close button, rail navigation, back-to-desktop, opening an
 * object) is routed through {@link UnsavedGuardController.requestLeave}. If any
 * registered probe reports dirty, a "Discard changes?" confirmation is shown
 * before the navigation proceeds.
 *
 * Because only the active screen is mounted at a time, the registry reflects the
 * current screen's dirty state — so over-wrapping navigation entry points is
 * safe: a clean screen passes straight through with no prompt.
 */

type DirtyProbe = () => boolean;

type UnsavedGuardContextValue = {
  register: (id: string, probe: DirtyProbe) => void;
  unregister: (id: string) => void;
  /** Run `proceed` immediately if nothing is dirty, else confirm first. Exposed
   *  so a screen can guard its own in-surface navigation (e.g. the Library
   *  editor switching pages without going through the shell's nav handlers). */
  requestLeave: (proceed: () => void) => void;
};

const UnsavedGuardContext = createContext<UnsavedGuardContextValue | null>(null);

export type UnsavedGuardController = {
  contextValue: UnsavedGuardContextValue;
  /** Run `proceed` immediately if nothing is dirty, else confirm first. */
  requestLeave: (proceed: () => void) => void;
  /** The confirmation dialog element; render it once near the shell root. */
  guardModal: ComponentChildren;
};

export function useUnsavedGuardController(): UnsavedGuardController {
  const registryRef = useRef<Map<string, DirtyProbe>>(new Map());
  const [pending, setPending] = useState<(() => void) | null>(null);
  // Mirror of `pending` readable inside the []-memoized requestLeave without
  // stale closures, so re-entrant calls (while a confirm is open) are ignored
  // rather than dropping the first proceed.
  const pendingRef = useRef<(() => void) | null>(null);
  pendingRef.current = pending;

  const register = useCallback((id: string, probe: DirtyProbe) => {
    registryRef.current.set(id, probe);
  }, []);

  const unregister = useCallback((id: string) => {
    registryRef.current.delete(id);
  }, []);

  const requestLeave = useCallback((proceed: () => void) => {
    // A confirm is already open: ignore competing navigation requests.
    if (pendingRef.current) {
      return;
    }
    let dirty = false;
    for (const probe of registryRef.current.values()) {
      try {
        if (probe()) {
          dirty = true;
          break;
        }
      } catch {
        // A throwing probe must never trap the user on a screen.
      }
    }
    if (dirty) {
      setPending(() => proceed);
    } else {
      proceed();
    }
  }, []);

  const contextValue = useMemo<UnsavedGuardContextValue>(
    () => ({ register, unregister, requestLeave }),
    [register, unregister, requestLeave],
  );

  const guardModal = pending ? (
    <div
      class="gsv-unsaved-guard-layer"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(4,3,16,.6)",
      }}
    >
      <ConfirmModal
        title="DISCARD CHANGES?"
        message="This screen has unsaved changes."
        note="If you leave now, your edits will be lost."
        cancelLabel="KEEP EDITING"
        confirmLabel="DISCARD"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const proceed = pending;
          setPending(null);
          proceed?.();
        }}
      />
    </div>
  ) : null;

  return {
    contextValue,
    requestLeave,
    guardModal,
  };
}

export function UnsavedGuardProvider({
  value,
  children,
}: {
  value: UnsavedGuardContextValue;
  children: ComponentChildren;
}) {
  return <UnsavedGuardContext.Provider value={value}>{children}</UnsavedGuardContext.Provider>;
}

/**
 * Register a dirty-state probe for the current screen. Pass a function that
 * returns `true` when the screen holds unsaved edits. The probe is read lazily
 * at navigation time, so it always sees the latest state.
 */
export function useUnsavedGuard(isDirty: DirtyProbe): void {
  const ctx = useContext(UnsavedGuardContext);
  const id = useId();
  const probeRef = useRef(isDirty);
  probeRef.current = isDirty;

  useEffect(() => {
    if (!ctx) {
      return;
    }
    const probe: DirtyProbe = () => probeRef.current();
    ctx.register(id, probe);
    return () => ctx.unregister(id);
  }, [ctx, id]);
}

/**
 * Access the guard's `requestLeave` so a screen can gate its own in-surface
 * navigation (which doesn't pass through the shell's nav handlers). Falls back
 * to running `proceed` immediately when there is no guard provider.
 */
export function useUnsavedGuardLeave(): (proceed: () => void) => void {
  const ctx = useContext(UnsavedGuardContext);
  return ctx?.requestLeave ?? ((proceed) => proceed());
}
