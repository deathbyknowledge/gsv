import { useEffect, useRef, useState } from "preact/hooks";
import "./Tabs.css";

export interface TabsProps {
  tabs?: string[];
  value?: number;
  onChange?: (i: number) => void;
  onClose?: (i: number) => void;
  width?: number;
  sticky?: boolean;
}

/** Tabs — ported from Tabs.dc.html. A row of chamfered tabs joined by a single
 *  continuous glowing rail. The active tab is transparent (revealing the host
 *  surface); unselected tabs draw their own outline. Geometry is derived from
 *  the bar's measured width via a ResizeObserver. */
export function Tabs({ tabs, value, onChange, onClose, width, sticky = false }: TabsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [hover, setHover] = useState(-1);
  const [w, setW] = useState(0);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const measure = () => {
      const cw = rootRef.current ? rootRef.current.clientWidth : 0;
      if (cw) setW((prev) => (cw !== prev ? cw : prev));
    };
    measure();
    if (typeof ResizeObserver !== "undefined" && rootRef.current) {
      const ro = new ResizeObserver(() => measure());
      ro.observe(rootRef.current);
      return () => ro.disconnect();
    }
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const tabList = Array.isArray(tabs) && tabs.length ? tabs : ["GENERAL", "FILES", "TASKS"];
  const controlled = value != null;
  const val = Math.max(0, Math.min(controlled ? (value as number) | 0 : sel | 0, tabList.length - 1));
  const emit = onChange || (() => {});
  const closeable = typeof onClose === "function";

  const select = (i: number, focus: boolean) => {
    if (!controlled) setSel(i);
    emit(i);
    if (focus) tabRefs.current[i]?.focus();
  };
  const onTabKeyDown = (e: KeyboardEvent, i: number) => {
    const last = tabList.length - 1;
    let next = -1;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = i >= last ? 0 : i + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = i <= 0 ? last : i - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(i, true);
        return;
      default:
        return;
    }
    e.preventDefault();
    select(next, true);
  };

  // width drives the single continuous rail path; prefer an explicit prop, else self-measured, else a safe default
  const W = (width != null ? +width : 0) || w || 600;
  const narrow = W < 720;
  const TAB_W = narrow ? 112 : 132;
  const TC = 15, TR = 8, TRT = 4; // chamfer / bottom-fillet radius / top-left radius
  const padTop = narrow ? 12 : 16, padL = narrow ? 12 : 30, GAP = 6;
  const RAIL_GLOW = "drop-shadow(0 0 2px rgba(179,174,255,.55)) drop-shadow(0 0 7px rgba(179,174,255,.4))";

  // CLOSED shape clips the fill: small convex top-left, chamfered right, both BOTTOM corners CONCAVE
  const tabClip = (Wt: number, H: number) =>
    'path("M ' + (TR + TRT) + " 0 L " + (Wt - TC) + " 0 L " + (Wt - TR) + " " + (H - TR) + " A " + TR + " " + TR + " 0 0 0 " + Wt + " " + H + " L 0 " + H + " A " + TR + " " + TR + " 0 0 0 " + TR + " " + (H - TR) + " L " + TR + " " + TRT + " A " + TRT + " " + TRT + " 0 0 1 " + (TR + TRT) + ' 0 Z")';
  // OPEN outline (no flat bottom) for unselected tabs — a real uniform SVG stroke
  const tabStroke = (Wt: number, H: number) =>
    "M " + Wt + " " + H + " A " + TR + " " + TR + " 0 0 1 " + (Wt - TR) + " " + (H - TR) + " L " + (Wt - TC) + " 0 L " + (TR + TRT) + " 0 A " + TRT + " " + TRT + " 0 0 0 " + TR + " " + TRT + " L " + TR + " " + (H - TR) + " A " + TR + " " + TR + " 0 0 1 0 " + H;

  const outerStyle = (i: number): string => {
    const active = i === val, H = active ? 32 : 28;
    return "position:relative;cursor:pointer;width:" + TAB_W + "px;height:" + H + "px;" + (i === 0 ? "" : "margin-left:" + GAP + "px;") + (active ? "z-index:3;" : "z-index:1;");
  };
  const innerStyle = (i: number): string => {
    const active = i === val, hov = i === hover, H = active ? 32 : 28;
    // active tab is TRANSPARENT — it reveals whatever texture/background the host page sits on
    const fill = active ? "background:transparent;" : "background-color:" + (hov ? "var(--active)" : "var(--header-bar)") + ";";
    return "position:absolute;left:0;top:0;width:" + TAB_W + "px;height:" + H + "px;clip-path:" + tabClip(TAB_W, H) + ";" + fill + "display:flex;align-items:center;justify-content:flex-start;gap:7px;box-sizing:border-box;padding-left:18px;padding-right:" + (closeable ? "10px" : "14px") + ";transition:background-color .12s;";
  };
  const textStyle = (i: number): string => {
    const active = i === val, hov = i === hover;
    const color = active ? "var(--accent-bright)" : hov ? "#cbc7ff" : "var(--accent)";
    return "min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gsv-font-mono);font-size:" + (narrow ? "11px" : "12px") + ";letter-spacing:.2em;font-weight:" + (active ? "700" : "500") + ";color:" + color + ";" + (active ? "text-shadow:0 0 7px rgba(179,174,255,.5);" : "text-shadow:0 0 6px rgba(150,140,255,.25);");
  };
  const closeStyle = (i: number): string => {
    const visible = i === val || i === hover;
    const color = visible ? "var(--accent-bright)" : "#7d78b8";
    return "appearance:none;margin:0;padding:0;flex:none;width:18px;height:18px;border:0;background:transparent;color:" + color + ";cursor:pointer;display:inline-flex;align-items:center;justify-content:center;opacity:" + (visible ? "1" : "0") + ";transition:opacity .12s,color .12s;";
  };
  const mkTabSvg = (i: number) => {
    const active = i === val, hov = i === hover;
    if (active) return null; // active outline comes from the single merged rail path
    const H = 28, sw = 1.5;
    const stroke = hov ? "var(--accent)" : "var(--border-raised)";
    const glow = hov ? "drop-shadow(0 0 3px rgba(179,174,255,.3))" : "none";
    return (
      <svg
        width={TAB_W}
        height={H + 4}
        viewBox={"0 0 " + TAB_W + " " + (H + 4)}
        style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", filter: glow, zIndex: 2 }}
        fill="none"
      >
        <path d={tabStroke(TAB_W, H)} stroke={stroke} stroke-width={sw} stroke-linecap="round" stroke-linejoin="round" fill="none" />
      </svg>
    );
  };

  // ONE continuous stroke for the whole top edge: rail in -> flare up the active tab -> over the top -> chamfer -> flare down -> rail out.
  const BH = padTop + 32, railY = BH, tabTopY = railY - 32;
  const ax0 = padL + val * (TAB_W + GAP), ax1 = ax0 + TAB_W;
  const railD =
    "M 0 " + railY +
    " L " + ax0 + " " + railY +
    " A " + TR + " " + TR + " 0 0 0 " + (ax0 + TR) + " " + (railY - TR) +
    " L " + (ax0 + TR) + " " + (tabTopY + TRT) +
    " A " + TRT + " " + TRT + " 0 0 1 " + (ax0 + TR + TRT) + " " + tabTopY +
    " L " + (ax1 - TC) + " " + tabTopY +
    " L " + (ax1 - TR) + " " + (railY - TR) +
    " A " + TR + " " + TR + " 0 0 0 " + ax1 + " " + railY +
    " L " + W + " " + railY;
  const railSvg = (
    <svg
      width={W}
      height={BH + 4}
      viewBox={"0 0 " + W + " " + (BH + 4)}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", filter: RAIL_GLOW, zIndex: 5 }}
      fill="none"
    >
      <path d={railD} stroke="var(--accent)" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" fill="none" />
    </svg>
  );

  const barStyle =
    (sticky ? "position:sticky;top:0;" : "position:relative;") +
    "z-index:6;display:flex;align-items:flex-end;overflow:visible;padding:" + (narrow ? "12px 12px 0" : "16px 30px 0") + ";background:transparent;";

  return (
    <div ref={rootRef} role="tablist" style={barStyle}>
      {railSvg}
      {tabList.map((label, i) => (
        <div
          ref={(el) => {
            tabRefs.current[i] = el;
          }}
          id={"gsv-tab-" + i}
          class="gsv-tab"
          role="tab"
          aria-selected={i === val}
          tabIndex={i === val ? 0 : -1}
          onClick={() => {
            if (!controlled) setSel(i);
            emit(i);
          }}
          onKeyDown={(e) => onTabKeyDown(e, i)}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(-1)}
          style={outerStyle(i)}
        >
          <div style={innerStyle(i)}>
            <span style={textStyle(i)}>{label}</span>
            {closeable ? (
              <button
                type="button"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                style={closeStyle(i)}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose?.(i);
                }}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(-1)}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">
                  <line x1="3" y1="3" x2="13" y2="13" />
                  <line x1="13" y1="3" x2="3" y2="13" />
                </svg>
              </button>
            ) : null}
          </div>
          {mkTabSvg(i)}
        </div>
      ))}
    </div>
  );
}
