import type { JSX, RefObject } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  chatMinimizedPositionAtPointer,
  clampChatMinimizedPosition,
  exceededChatMinimizedDragThreshold,
  type ChatMinimizedPoint,
  type ChatMinimizedSize,
  type ChatMinimizedViewport,
} from "../domain/minimizedChatPosition";

type UseDraggableMinimizedChatOptions = {
  open: boolean;
  onActivate: () => void;
};

type MinimizedChatDrag = {
  moved: boolean;
  node: HTMLButtonElement;
  pointerId: number;
  pointerOffset: ChatMinimizedPoint;
  start: ChatMinimizedPoint;
};

export type DraggableMinimizedChat = {
  dragging: boolean;
  launcherRef: RefObject<HTMLButtonElement>;
  style: JSX.CSSProperties | undefined;
  onClick: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => void;
};

type MinimizedChatGeometry = {
  launcher: ChatMinimizedSize;
  position: ChatMinimizedPoint;
  viewport: ChatMinimizedViewport;
};

function samePosition(left: ChatMinimizedPoint, right: ChatMinimizedPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function minimizedChatGeometry(node: HTMLButtonElement): MinimizedChatGeometry | null {
  const viewportNode = node.closest<HTMLElement>(".gsv-shell-viewport");
  if (!viewportNode) {
    return null;
  }

  const viewportRect = viewportNode.getBoundingClientRect();
  const launcherRect = node.getBoundingClientRect();
  if (viewportRect.width <= 0 || viewportRect.height <= 0 || launcherRect.width <= 0 || launcherRect.height <= 0) {
    return null;
  }

  return {
    launcher: {
      width: launcherRect.width,
      height: launcherRect.height,
    },
    position: {
      x: launcherRect.left - viewportRect.left,
      y: launcherRect.top - viewportRect.top,
    },
    viewport: {
      left: viewportRect.left,
      top: viewportRect.top,
      width: viewportRect.width,
      height: viewportRect.height,
    },
  };
}

function applyMinimizedChatPosition(node: HTMLButtonElement, position: ChatMinimizedPoint): void {
  node.style.left = `${position.x}px`;
  node.style.top = `${position.y}px`;
  node.style.right = "auto";
  node.style.bottom = "auto";
}

export function useDraggableMinimizedChat({
  open,
  onActivate,
}: UseDraggableMinimizedChatOptions): DraggableMinimizedChat {
  const [position, setPosition] = useState<ChatMinimizedPoint | null>(null);
  const [dragging, setDragging] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const positionRef = useRef<ChatMinimizedPoint | null>(null);
  const dragRef = useRef<MinimizedChatDrag | null>(null);
  const suppressClickRef = useRef(false);
  const suppressGenerationRef = useRef(0);
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;

  const commitPosition = useCallback((next: ChatMinimizedPoint): void => {
    positionRef.current = next;
    setPosition(next);
  }, []);

  const deferClickSuppressionClear = useCallback((): void => {
    const generation = ++suppressGenerationRef.current;
    suppressClickRef.current = true;
    requestAnimationFrame(() => {
      if (suppressGenerationRef.current === generation) {
        suppressClickRef.current = false;
      }
    });
  }, []);

  const finishDrag = useCallback((pointerId: number, suppressClick: boolean): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return;
    }

    dragRef.current = null;
    if (drag.node.hasPointerCapture(pointerId)) {
      drag.node.releasePointerCapture(pointerId);
    }
    if (drag.moved && positionRef.current) {
      commitPosition(positionRef.current);
    }
    setDragging(false);
    if (drag.moved && suppressClick) {
      deferClickSuppressionClear();
    }
  }, [commitPosition, deferClickSuppressionClear]);

  const onPointerDown = useCallback((event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) {
      return;
    }

    if (!minimizedChatGeometry(event.currentTarget)) {
      return;
    }

    const launcherRect = event.currentTarget.getBoundingClientRect();
    suppressClickRef.current = false;
    suppressGenerationRef.current += 1;
    dragRef.current = {
      moved: false,
      node: event.currentTarget,
      pointerId: event.pointerId,
      pointerOffset: {
        x: event.clientX - launcherRect.left,
        y: event.clientY - launcherRect.top,
      },
      start: { x: event.clientX, y: event.clientY },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (!drag.moved && !exceededChatMinimizedDragThreshold(
      drag.start,
      { x: event.clientX, y: event.clientY },
    )) {
      return;
    }

    const geometry = minimizedChatGeometry(drag.node);
    if (!geometry) {
      return;
    }

    event.preventDefault();
    const next = chatMinimizedPositionAtPointer(
      { x: event.clientX, y: event.clientY },
      drag.pointerOffset,
      geometry.viewport,
      geometry.launcher,
    );
    positionRef.current = next;
    applyMinimizedChatPosition(drag.node, next);

    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
      setPosition(next);
    }
  }, []);

  const onPointerUp = useCallback((event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    // A fast gesture may be delivered without an intermediate pointermove, so
    // process the release coordinates before deciding whether this was a click.
    onPointerMove(event);
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId && drag.moved) {
      event.preventDefault();
    }
    finishDrag(event.pointerId, true);
  }, [finishDrag, onPointerMove]);

  const onPointerCancel = useCallback((event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    finishDrag(event.pointerId, false);
  }, [finishDrag]);

  const onLostPointerCapture = useCallback((event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    finishDrag(event.pointerId, true);
  }, [finishDrag]);

  const onClick = useCallback((event: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
      suppressGenerationRef.current += 1;
      return;
    }
    activateRef.current();
  }, []);

  const onKeyDown = useCallback((event: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void => {
    const step = event.shiftKey ? 32 : 8;
    const delta = event.key === "ArrowLeft"
      ? { x: -step, y: 0 }
      : event.key === "ArrowRight"
        ? { x: step, y: 0 }
        : event.key === "ArrowUp"
          ? { x: 0, y: -step }
          : event.key === "ArrowDown"
            ? { x: 0, y: step }
            : null;
    if (!delta) {
      return;
    }

    const geometry = minimizedChatGeometry(event.currentTarget);
    if (!geometry) {
      return;
    }

    event.preventDefault();
    const next = clampChatMinimizedPosition({
      x: geometry.position.x + delta.x,
      y: geometry.position.y + delta.y,
    }, geometry.viewport, geometry.launcher);
    applyMinimizedChatPosition(event.currentTarget, next);
    commitPosition(next);
  }, [commitPosition]);

  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (open && drag) {
      finishDrag(drag.pointerId, false);
    }
  }, [finishDrag, open]);

  useEffect(() => {
    const finishActiveDrag = (): void => {
      const drag = dragRef.current;
      if (drag) {
        finishDrag(drag.pointerId, false);
      }
    };
    window.addEventListener("blur", finishActiveDrag);
    return () => window.removeEventListener("blur", finishActiveDrag);
  }, [finishDrag]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    if (open || !positioned) {
      return;
    }

    const node = launcherRef.current;
    if (!node) {
      return;
    }

    const reclamp = (): void => {
      const current = positionRef.current;
      const geometry = minimizedChatGeometry(node);
      if (!current || !geometry) {
        return;
      }
      const next = clampChatMinimizedPosition(current, geometry.viewport, geometry.launcher);
      if (samePosition(current, next)) {
        return;
      }
      applyMinimizedChatPosition(node, next);
      commitPosition(next);
    };

    reclamp();
    window.addEventListener("resize", reclamp);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", reclamp);
    }

    const viewportNode = node.closest<HTMLElement>(".gsv-shell-viewport");
    const observer = new ResizeObserver(reclamp);
    observer.observe(node);
    if (viewportNode) {
      observer.observe(viewportNode);
    }
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reclamp);
    };
  }, [commitPosition, open, positioned]);

  const style = useMemo<JSX.CSSProperties | undefined>(() => position ? {
    left: `${position.x}px`,
    top: `${position.y}px`,
    right: "auto",
    bottom: "auto",
  } : undefined, [position?.x, position?.y]);

  return {
    dragging,
    launcherRef,
    style,
    onClick,
    onKeyDown,
    onLostPointerCapture,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
