/**
 * Surface Protocol — renderable views managed by the Gateway display server.
 *
 * A Surface is the protocol-level abstraction for a renderable view.
 * It maps to:
 *   - A window in the OS-shell web UI
 *   - A WebView on native node clients (future)
 *   - A panel in terminal-mode clients (future)
 *
 * The Gateway maintains the authoritative surface registry; clients
 * send requests to open/close/update, and the gateway broadcasts
 * state changes to all connected clients via events.
 */

// ── Surface Kind ──
// What kind of content this surface renders.
export type SurfaceKind =
  | "app"       // built-in app tab (chat, settings, overview, etc.)
  | "media"     // media player (video, audio, image)
  | "component" // custom agent-rendered component (future)
  | "webview";  // arbitrary URL (future)

// ── Surface State ──
export type SurfaceState = "open" | "minimized" | "closed";

// ── Position / size hint ──
export type SurfaceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// ── Core Surface record ──
export type Surface = {
  surfaceId: string;
  kind: SurfaceKind;
  label: string;
  contentRef: string;         // tab name, media URL, component ID, or URL
  contentData?: unknown;      // extra data (component props, media metadata)
  targetClientId: string;     // which client/node should render this
  sourceClientId?: string;    // who requested opening it
  sourceSessionKey?: string;  // if opened by an agent tool
  state: SurfaceState;
  rect?: SurfaceRect;
  zIndex?: number;
  createdAt: number;
  updatedAt: number;
  // Browser profile persistence (webview surfaces)
  profileId?: string;         // derived from URL origin (e.g. "github.com")
  profileVersion?: number;    // monotonic, incremented on each R2 upload
  profileLock?: {             // set when a node has the profile open
    nodeId: string;
    surfaceId: string;
  };
};

// ── RPC params / results ──

export type SurfaceOpenParams = {
  kind: SurfaceKind;
  label?: string;
  contentRef: string;
  contentData?: unknown;
  targetClientId?: string;    // omit = self
  state?: SurfaceState;       // default "open"
  rect?: SurfaceRect;
};

export type SurfaceOpenResult = {
  surface: Surface;
};

export type SurfaceCloseParams = {
  surfaceId: string;
};

export type SurfaceCloseResult = {
  ok: true;
  surfaceId: string;
};

export type SurfaceUpdateParams = {
  surfaceId: string;
  state?: SurfaceState;
  rect?: SurfaceRect;
  label?: string;
  zIndex?: number;
  contentData?: unknown;
};

export type SurfaceUpdateResult = {
  surface: Surface;
};

export type SurfaceFocusParams = {
  surfaceId: string;
};

export type SurfaceFocusResult = {
  surface: Surface;
};

export type SurfaceListParams = {
  targetClientId?: string;    // filter by target client
} | undefined;

export type SurfaceListResult = {
  surfaces: Surface[];
  count: number;
};

// ── Eval (JavaScript execution in webview surfaces) ──

export type SurfaceEvalParams = {
  surfaceId: string;
  /** JavaScript code to execute in the webview context. */
  script: string;
  /** Unique eval ID for correlating the async result. Auto-generated if omitted. */
  evalId?: string;
};

export type SurfaceEvalResult = {
  evalId: string;
  surfaceId: string;
  /** True if the script executed without throwing. */
  ok: boolean;
  /** JSON-serializable return value from the script (if ok). */
  result?: unknown;
  /** Error message (if !ok). */
  error?: string;
};

// ── Event payloads ──

export type SurfaceOpenedPayload = {
  surface: Surface;
};

export type SurfaceClosedPayload = {
  surfaceId: string;
  targetClientId: string;
  profileId?: string;
};

export type SurfaceUpdatedPayload = {
  surface: Surface;
};

/** Sent by gateway to the target node to request JS execution. */
export type SurfaceEvalRequestPayload = {
  evalId: string;
  surfaceId: string;
  script: string;
};

/** Sent by the node back to gateway with the eval result. */
export type SurfaceEvalResultPayload = {
  evalId: string;
  surfaceId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
