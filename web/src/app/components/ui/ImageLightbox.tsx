import { createPortal } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { CloseGlyph, DownloadGlyph, MinusGlyph, PlusGlyph } from "./lineGlyphs";
import {
  clampOffset,
  clampZoom,
  CLICK_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  zoomAboutPoint,
  zoomPercent,
  type Point,
  type Size,
} from "./imageLightboxGeometry";
import "./ImageLightbox.css";

export interface ImageLightboxProps {
  src: string;
  /** Alt text for the enlarged image — usually the filename. */
  alt: string;
  /** Shown in the toolbar and used as the download name. */
  filename?: string;
  /** Quieter detail beside the name — when the image was sent. Pre-formatted,
   *  so this primitive stays out of the transcript's date handling. */
  meta?: string;
  /** Longer description under the toolbar (a model's image description). */
  caption?: string;
  onClose: () => void;
}

const ORIGIN: Point = { x: 0, y: 0 };

/** ImageLightbox — full-screen image viewer: click the photo to zoom in at
 *  that point and again to fit, wheel and pinch zoom anchored at the pointer,
 *  drag to pan, download, click the backdrop or press Escape to close.
 *  Portaled to <body> so no transcript ancestor's overflow or transform can
 *  clip it, and so the scrim covers the whole shell rather than the dock. */
export function ImageLightbox({ src, alt, filename, meta, caption, onClose }: ImageLightboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [scale, setScale] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Point>(ORIGIN);
  /** Live pointers, so two of them can drive a pinch. */
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<{ distance: number; anchor: Point } | null>(null);
  const panRef = useRef<{ pointerId: number; origin: Point; offset: Point } | null>(null);
  /** A drag that ends on the backdrop must not also read as a dismiss click. */
  const draggedRef = useRef(false);
  /** Whether the press landed on the image. Panning takes pointer capture, and
   *  a captured pointer retargets the following click to the capturing
   *  element — so the click's own target would report the stage even when the
   *  press was squarely on the photo. */
  const pressedImageRef = useRef(false);

  /** Layout sizes. The transform never affects layout, so the image's offset
   *  box is always its fitted (scale 1) size — exactly the base the pan bounds
   *  need. */
  const measure = useCallback((): { content: Size; stage: Size } => {
    const image = imageRef.current;
    const stage = stageRef.current;
    return {
      content: { width: image?.offsetWidth ?? 0, height: image?.offsetHeight ?? 0 },
      stage: { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 },
    };
  }, []);

  /** Pointer position relative to the stage centre — the frame every geometry
   *  helper works in. */
  const anchorFor = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return ORIGIN;
    }
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
  }, []);

  const zoomTo = useCallback((next: number, anchor: Point) => {
    setScale((current) => {
      const target = clampZoom(next);
      const { content, stage } = measure();
      setOffset((currentOffset) =>
        clampOffset(zoomAboutPoint(currentOffset, current, target, anchor), content, stage, target),
      );
      return target;
    });
  }, [measure]);

  const zoomBy = useCallback((factor: number) => zoomTo(scale * factor, ORIGIN), [scale, zoomTo]);
  const resetView = useCallback(() => {
    setScale(MIN_ZOOM);
    setOffset(ORIGIN);
  }, []);

  // Escape closes; the usual viewer keys work once the panel has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetView();
        return;
      }
      if (event.key === "Tab") {
        // Same trap as Dialog/ConfirmModal: the viewer is aria-modal, so Tab
        // must not reach the transcript behind it, where a control would be
        // invisible but still clickable. Disabled controls (zoom out at fit)
        // are not Tab stops, so wrapping to them would let focus escape.
        const root = rootRef.current;
        if (!root) {
          return;
        }
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
        if (focusable.length === 0) {
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !root.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !root.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, resetView, zoomBy]);

  // Wheel has to be a non-passive listener to keep the page from scrolling
  // behind the viewer, which rules out the JSX onWheel prop.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomTo(scale * factor, anchorFor(event.clientX, event.clientY));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [anchorFor, scale, zoomTo]);

  // Focus the close button so Escape and Tab have somewhere to land, and give
  // focus back to whatever opened the viewer.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // The page behind must not scroll while the viewer owns the screen.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // A window resize changes the fitted size, so the current pan can fall out
  // of bounds — pull it back in.
  useEffect(() => {
    const onResize = () => {
      const { content, stage } = measure();
      setOffset((current) => clampOffset(current, content, stage, scale));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure, scale]);

  const onPointerDown = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    draggedRef.current = false;
    pressedImageRef.current = event.target === imageRef.current;
    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        anchor: anchorFor((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      panRef.current = null;
      return;
    }
    if (scale > MIN_ZOOM) {
      panRef.current = {
        pointerId: event.pointerId,
        origin: { x: event.clientX, y: event.clientY },
        offset,
      };
      target.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) {
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const pinch = pinchRef.current;
    if (pinch && pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0 && distance > 0) {
        zoomTo(scale * (distance / pinch.distance), pinch.anchor);
        pinchRef.current = { distance, anchor: pinch.anchor };
      }
      draggedRef.current = true;
      return;
    }

    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    const next = {
      x: pan.offset.x + (event.clientX - pan.origin.x),
      y: pan.offset.y + (event.clientY - pan.origin.y),
    };
    if (Math.abs(next.x - pan.offset.x) > 2 || Math.abs(next.y - pan.offset.y) > 2) {
      draggedRef.current = true;
    }
    const { content, stage } = measure();
    setOffset(clampOffset(next, content, stage, scale));
  };

  const endPointer = (event: PointerEvent) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
    }
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
    }
  };

  /** A click on the photo is the zoom toggle: in at the clicked point, back to
   *  fit when already zoomed. A click on the empty stage around it dismisses.
   *  Either way the tail end of a pan is not a click. */
  const onStageClick = (event: MouseEvent) => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (!pressedImageRef.current) {
      onClose();
      return;
    }
    if (scale > MIN_ZOOM) {
      resetView();
      return;
    }
    zoomTo(CLICK_ZOOM, anchorFor(event.clientX, event.clientY));
  };

  const zoomedIn = scale > MIN_ZOOM;
  const label = filename || alt || "Image";

  return createPortal(
    <div
      ref={rootRef}
      class="gsv-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${label} — image viewer`}
      tabIndex={-1}
    >
      <div class="gsv-lightbox-bar">
        <span class="gsv-lightbox-name gsv-sublabel">{label}</span>
        {meta ? <span class="gsv-lightbox-meta gsv-sublabel">{meta}</span> : null}
        <span class="gsv-lightbox-controls">
          <button
            type="button"
            class="gsv-lightbox-btn"
            disabled={scale <= MIN_ZOOM}
            title="Zoom out (-)"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <MinusGlyph size={12} />
          </button>
          <button
            type="button"
            class="gsv-lightbox-zoom gsv-sublabel"
            title="Reset to fit (0)"
            aria-label="Reset zoom"
            onClick={resetView}
          >
            {zoomPercent(scale)}
          </button>
          <button
            type="button"
            class="gsv-lightbox-btn"
            title="Zoom in (+)"
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <PlusGlyph size={12} />
          </button>
          <a
            class="gsv-lightbox-btn"
            href={src}
            download={filename || alt || "image"}
            title="Download"
            aria-label="Download image"
          >
            <DownloadGlyph size={12} />
          </a>
          <button
            ref={closeRef}
            type="button"
            class="gsv-lightbox-btn"
            title="Close (Esc)"
            aria-label="Close image viewer"
            onClick={onClose}
          >
            <CloseGlyph size={12} />
          </button>
        </span>
      </div>

      <div
        ref={stageRef}
        class={`gsv-lightbox-stage${zoomedIn ? " is-zoomed" : ""}`}
        onClick={onStageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>

      {caption ? <p class="gsv-lightbox-caption">{caption}</p> : null}
    </div>,
    document.body,
  );
}
