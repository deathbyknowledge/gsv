const STARFIELD_SHELL_HTML = `
  <main id="page" class="page">
    <canvas id="starfield" aria-label="Animated ASCII starfield"></canvas>

    <section id="intro-screen" class="intro-screen" aria-label="Intro">
      <div class="intro-card">
        <span class="intro-kicker">Pretext Demo</span>
        <h1 class="intro-title">ASCII Starfield</h1>
        <p class="intro-copy">
          A first-person solar-system flythrough rendered as text.
          <strong>Pretext</strong> fits the text grid and layout surfaces; the scene itself is drawn live into that field.
        </p>
        <div class="intro-controls intro-controls-desktop" aria-label="Desktop controls">
          <span>Mouse to look, click to lock</span>
          <span>W A S D to move, Q / E to rise and descend</span>
          <span>Shift to boost, Space to brake, aim at bodies for briefs</span>
        </div>
        <div class="intro-controls intro-controls-touch" aria-label="Touch controls">
          <span>Left stick to move, right stick to look</span>
          <span>Up / Down for lift, Brake to stop, Info to open briefs</span>
        </div>
        <div class="intro-actions">
          <button id="intro-start" class="intro-start" type="button">Start Flight</button>
          <span class="intro-note">The scene is already running behind this screen. Start drops you straight into free flight.</span>
        </div>
      </div>
    </section>

    <div class="readout readout-date" aria-label="Simulation date">
      <span class="readout-label">Date</span>
      <span id="sim-date" class="readout-value"></span>
    </div>

    <div class="readout readout-speed" aria-label="Current speed">
      <span class="readout-label">Speed</span>
      <span id="speedometer" class="readout-value"></span>
    </div>

    <div class="readout readout-fps" aria-label="Frame rate">
      <span class="readout-label">FPS</span>
      <span id="fps" class="readout-value"></span>
    </div>

    <aside class="minimap-shell" aria-label="Solar system minimap">
      <canvas id="minimap" class="minimap" width="200" height="200" aria-label="Solar system minimap"></canvas>
    </aside>

    <aside id="ask-panel" class="ask-panel" aria-label="Question panel" hidden>
      <div class="ask-panel-head">
        <span class="ask-panel-kicker">Field Guide</span>
        <h2 id="ask-title" class="ask-panel-title"></h2>
        <p id="ask-context" class="ask-panel-context"></p>
      </div>

      <div class="ask-brief">
        <p id="ask-summary" class="ask-summary"></p>
        <div id="ask-telemetry" class="ask-telemetry"></div>
      </div>

      <form id="ask-form" class="ask-form">
        <label class="sr-only" for="ask-input">Ask a question about the selected body</label>
        <input id="ask-input" class="ask-input" type="text" autocomplete="off" spellcheck="false" placeholder="Ask a question">
        <button id="ask-submit" class="ask-submit" type="submit">Ask</button>
      </form>

      <div class="ask-section">
        <span class="ask-label">Suggested Questions</span>
        <div id="ask-suggestions" class="ask-suggestions"></div>
      </div>
    </aside>

    <div id="answer-layer" class="answer-layer" aria-live="polite"></div>

    <div class="touch-overlay" aria-label="Touch flight controls">
      <div id="touch-move" class="touch-stick touch-stick-left">
        <div id="touch-move-knob" class="touch-stick-knob"></div>
        <span class="touch-stick-label">Move</span>
      </div>

      <div class="touch-actions">
        <button id="touch-lift-up" class="touch-action" type="button">Up</button>
        <button id="touch-brief" class="touch-action" type="button">Info</button>
        <button id="touch-lift-down" class="touch-action" type="button">Down</button>
        <button id="touch-brake" class="touch-action touch-action-wide" type="button">Brake</button>
      </div>

      <div id="touch-look" class="touch-stick touch-stick-right">
        <div id="touch-look-knob" class="touch-stick-knob"></div>
        <span class="touch-stick-label">Look</span>
      </div>
    </div>
  </main>
`

mountStarfieldShell()

type InfoDatum = {
  label: string
  value: string
}

type Rgb = {
  r: number
  g: number
  b: number
}

type HudBriefContext = {
  id: string
  name: string
  kind: string
  bodyType: 'star' | 'planet' | 'moon'
  summary: string
  accent: Rgb
  briefData: readonly InfoDatum[]
}

type HudSnapshot = {
  speed: number
  timeMs: number
  brief: HudBriefContext | null
  panels: WorldPanelProjection[]
}

type AnswerWindowRecord = {
  id: number
  root: HTMLDivElement
  answer: HTMLParagraphElement
  timerId: number | null
  pid: string | null
  runId: string | null
  receivedText: boolean
}

type WorldPanelProjection = {
  id: number
  kind: 'brief' | 'answer'
  bodyId: string
  screenX: number
  screenY: number
  scale: number
  visible: boolean
}

type ScreenRect = {
  left: number
  top: number
  right: number
  bottom: number
}

type WorkerViewport = {
  width: number
  height: number
  minimapWidth: number
  minimapHeight: number
  dpr: number
}

type WorkerInitMessage = {
  type: 'init'
  canvas: OffscreenCanvas
  minimap: OffscreenCanvas
  viewport: WorkerViewport
}

type WorkerMessage =
  | { type: 'resize', viewport: WorkerViewport }
  | { type: 'frame', timestamp: number }
  | { type: 'flight-started' }
  | { type: 'open-answer-panel', id: number, bodyId: string }
  | { type: 'close-answer-panel', id: number }
  | { type: 'keydown', code: string, repeat: boolean }
  | { type: 'keyup', code: string }
  | { type: 'pointer-move', movementX: number, movementY: number }
  | { type: 'pointer-lock', locked: boolean }
  | { type: 'pointer-lock-notice', text: string, durationMs: number }
  | { type: 'touch-controls', moveX: number, moveY: number, lookX: number, lookY: number, lift: number, braking: boolean }
  | { type: 'touch-activate' }
  | { type: 'clear-keys' }

type WorkerSnapshotMessage = {
  type: 'snapshot'
  hud: HudSnapshot
}

type HostBridgeStatus = {
  state: 'disconnected' | 'connecting' | 'connected'
  url: string | null
  username: string | null
  connectionId: string | null
  message: string | null
}

type ProcSpawnArgs = {
  profile: 'init' | 'task' | 'cron' | 'mcp' | 'app'
  label?: string
  prompt?: string
  parentPid?: string
  workspace?: {
    mode: 'none' | 'new' | 'inherit' | 'attach'
    label?: string
    kind?: 'thread' | 'app' | 'shared'
    workspaceId?: string
  }
}

type ProcSpawnResult =
  | {
      ok: true
      pid: string
      label?: string
      profile: 'init' | 'task' | 'cron' | 'mcp' | 'app'
      workspaceId: string | null
      cwd: string
    }
  | { ok: false, error: string }

type ProcSendResult =
  | { ok: true, status: 'started', runId: string, queued?: boolean }
  | { ok: false, error: string }

type HostBridgeClient = {
  getStatus: () => HostBridgeStatus
  isConnected: () => boolean
  onSignal: (listener: (signal: string, payload: unknown) => void) => () => void
  onStatus: (listener: (status: HostBridgeStatus) => void) => () => void
  call: <T = unknown>(call: string, args?: unknown) => Promise<T>
  spawnProcess: (args: ProcSpawnArgs) => Promise<ProcSpawnResult>
  sendMessage: (message: string, pid?: string) => Promise<ProcSendResult>
}

function mountStarfieldShell(): void {
  document.title = 'ASCII Starfield'
  const root = document.getElementById('root')
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing #root mount')
  }
  root.innerHTML = STARFIELD_SHELL_HTML
}

const page = getRequiredMain('page')
const canvas = getRequiredCanvas('starfield')
const minimap = getRequiredCanvas('minimap')
const speedometer = getRequiredSpan('speedometer')
const simDate = getRequiredSpan('sim-date')
const fps = getRequiredSpan('fps')
const introScreen = getRequiredMain('intro-screen')
const introStartButton = getRequiredButton('intro-start')
const askPanel = getRequiredMain('ask-panel')
const askTitle = getRequiredMain('ask-title')
const askContext = getRequiredMain('ask-context')
const askSummary = getRequiredMain('ask-summary')
const askTelemetry = getRequiredDiv('ask-telemetry')
const askForm = getRequiredForm('ask-form')
const askInput = getRequiredInput('ask-input')
const askSubmitButton = getRequiredButton('ask-submit')
const askSuggestions = getRequiredDiv('ask-suggestions')
const answerLayer = getRequiredDiv('answer-layer')
const touchMoveZone = getRequiredDiv('touch-move')
const touchMoveKnob = getRequiredDiv('touch-move-knob')
const touchLookZone = getRequiredDiv('touch-look')
const touchLookKnob = getRequiredDiv('touch-look-knob')
const touchLiftUpButton = getRequiredButton('touch-lift-up')
const touchLiftDownButton = getRequiredButton('touch-lift-down')
const touchBrakeButton = getRequiredButton('touch-brake')
const touchBriefButton = getRequiredButton('touch-brief')
const simulationDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
})
const simulationDateLongFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})
const prefersTouchControls = window.matchMedia('(hover: none), (pointer: coarse)').matches
const hudObstacleElements = Array.from(document.querySelectorAll<HTMLElement>('.readout, .minimap-shell'))
const HOST_BRIDGE_TIMEOUT_MS = 20_000

speedometer.textContent = '0.0u/s'
simDate.textContent = '...'
fps.textContent = '--'
askSubmitButton.disabled = true
askInput.disabled = true

if (typeof canvas.transferControlToOffscreen !== 'function') {
  throw new Error('OffscreenCanvas transfer is required for this demo')
}

const worker = new Worker(new URL('./ascii-starfield.ts', import.meta.url), { type: 'module' })
const offscreenCanvas = canvas.transferControlToOffscreen()
const offscreenMinimap = minimap.transferControlToOffscreen()

let initialized = false
let framePending = false
let lastSnapshotAt = 0
let smoothedFps = 0
let flightStarted = false
let currentSimulationTimeMs = Date.now()
let activeBrief: HudBriefContext | null = null
let suggestionTimer: number | null = null
let nextAnswerWindowId = 1
const answerWindows: AnswerWindowRecord[] = []
let hostClient: HostBridgeClient | null = null
const touchState = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  lift: 0,
  braking: false,
}
let touchLiftUpPressed = false
let touchLiftDownPressed = false

function getRequiredCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLCanvasElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredMain(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredSpan(id: string): HTMLSpanElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLSpanElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredDiv(id: string): HTMLDivElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLDivElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredButton(id: string): HTMLButtonElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredInput(id: string): HTMLInputElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredForm(id: string): HTMLFormElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLFormElement)) throw new Error(`#${id} not found`)
  return element
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `host-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function connectHostClient(timeoutMs = HOST_BRIDGE_TIMEOUT_MS): Promise<HostBridgeClient | null> {
  if (!window.parent || window.parent === window) {
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for HOST bridge'))
    }, timeoutMs)

    const cleanup = (): void => {
      window.clearTimeout(timerId)
      window.removeEventListener('message', onMessage)
    }

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin) return
      const record = asRecord(event.data)
      if (!record || record.type !== 'gsv-host-connect') return
      const port = event.ports[0]
      if (!(port instanceof MessagePort)) {
        cleanup()
        reject(new Error('HOST bridge did not provide a message port'))
        return
      }
      cleanup()
      resolve(createEmbeddedHostClient(port))
    }

    window.addEventListener('message', onMessage)
  })
}

function createEmbeddedHostClient(port: MessagePort): HostBridgeClient {
  let status: HostBridgeStatus = {
    state: 'connecting',
    url: window.location.origin,
    username: null,
    connectionId: null,
    message: 'Waiting for host bridge...',
  }
  const statusListeners = new Set<(status: HostBridgeStatus) => void>()
  const signalListeners = new Set<(signal: string, payload: unknown) => void>()
  const pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeoutId: number
  }>()

  const emitStatus = (): void => {
    for (const listener of statusListeners) listener(status)
  }

  port.onmessage = event => {
    const record = asRecord(event.data)
    if (!record || typeof record.type !== 'string') return

    if (record.type === 'status') {
      status = (record.status as HostBridgeStatus | undefined) ?? status
      emitStatus()
      return
    }

    if (record.type === 'signal') {
      const signal = asString(record.signal)
      if (!signal) return
      for (const listener of signalListeners) listener(signal, record.payload)
      return
    }

    if (record.type !== 'rpc-result') return
    const id = asString(record.id)
    if (!id) return
    const pendingRequest = pending.get(id)
    if (!pendingRequest) return
    pending.delete(id)
    window.clearTimeout(pendingRequest.timeoutId)
    if (record.ok === true) {
      pendingRequest.resolve(record.data)
      return
    }
    pendingRequest.reject(new Error(asString(record.error) ?? 'HOST request failed'))
  }
  port.start()

  const rpc = <T>(method: string, payload?: unknown): Promise<T> => {
    const id = makeId()
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error(`HOST request timed out: ${method}`))
      }, HOST_BRIDGE_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timeoutId })
      port.postMessage({ type: 'rpc', id, method, payload })
    })
  }

  return {
    getStatus: () => status,
    isConnected: () => status.state === 'connected',
    onSignal: listener => {
      signalListeners.add(listener)
      return () => signalListeners.delete(listener)
    },
    onStatus: listener => {
      statusListeners.add(listener)
      listener(status)
      return () => statusListeners.delete(listener)
    },
    call: (call, args) => rpc('call', { call, args: args ?? {} }),
    spawnProcess: args => rpc('spawnProcess', args),
    sendMessage: (message, pid) => rpc('sendMessage', { message, pid }),
  }
}

function getViewport(): WorkerViewport {
  const canvasRect = canvas.getBoundingClientRect()
  const minimapRect = minimap.getBoundingClientRect()
  return {
    width: Math.max(1, Math.round(canvasRect.width)),
    height: Math.max(1, Math.round(canvasRect.height)),
    minimapWidth: Math.max(1, Math.round(minimapRect.width)),
    minimapHeight: Math.max(1, Math.round(minimapRect.height)),
    dpr: Math.max(1, window.devicePixelRatio || 1),
  }
}

function syncViewportCssVariables(): void {
  const viewport = window.visualViewport
  const width = Math.max(1, Math.round(viewport?.width ?? window.innerWidth))
  const height = Math.max(1, Math.round(viewport?.height ?? window.innerHeight))
  const rootStyle = document.documentElement.style
  rootStyle.setProperty('--app-width', `${width}px`)
  rootStyle.setProperty('--app-height', `${height}px`)
}

function postResizeAfterLayout(): void {
  syncViewportCssVariables()
  requestAnimationFrame(() => {
    postWorkerMessage({ type: 'resize', viewport: getViewport() })
  })
}

function postWorkerMessage(message: WorkerMessage): void {
  worker.postMessage(message)
}

function postTouchControls(): void {
  postWorkerMessage({
    type: 'touch-controls',
    moveX: touchState.moveX,
    moveY: touchState.moveY,
    lookX: touchState.lookX,
    lookY: touchState.lookY,
    lift: touchState.lift,
    braking: touchState.braking,
  })
}

function updateTouchLift(): void {
  touchState.lift = (touchLiftUpPressed ? 1 : 0) - (touchLiftDownPressed ? 1 : 0)
  postTouchControls()
}

function clearTouchControls(): void {
  touchState.moveX = 0
  touchState.moveY = 0
  touchState.lookX = 0
  touchState.lookY = 0
  touchState.lift = 0
  touchState.braking = false
  touchLiftUpPressed = false
  touchLiftDownPressed = false
  touchMoveKnob.style.transform = 'translate(-50%, -50%)'
  touchLookKnob.style.transform = 'translate(-50%, -50%)'
  touchMoveZone.classList.remove('touch-stick-active')
  touchLookZone.classList.remove('touch-stick-active')
  touchLiftUpButton.classList.remove('touch-action-active')
  touchLiftDownButton.classList.remove('touch-action-active')
  touchBrakeButton.classList.remove('touch-action-active')
  touchBriefButton.classList.remove('touch-action-active')
  postTouchControls()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toCssColor(color: Rgb, alpha = 1): string {
  const red = Math.round(clamp(color.r, 0, 1) * 255)
  const green = Math.round(clamp(color.g, 0, 1) * 255)
  const blue = Math.round(clamp(color.b, 0, 1) * 255)
  return `rgb(${red} ${green} ${blue} / ${clamp(alpha, 0, 1)})`
}

function getBodyDisplayName(name: string): string {
  return name.charAt(0) + name.slice(1).toLowerCase()
}

function getBriefFact(brief: HudBriefContext, label: string): string | null {
  const entry = brief.briefData.find(item => item.label === label)
  return entry?.value ?? null
}

function clearSuggestionTimer(): void {
  if (suggestionTimer === null) return
  window.clearTimeout(suggestionTimer)
  suggestionTimer = null
}

function clearAnswerWindowTimer(windowRecord: AnswerWindowRecord): void {
  if (windowRecord.timerId === null) return
  window.clearTimeout(windowRecord.timerId)
  windowRecord.timerId = null
}

function findAnswerWindowByPid(pid: string): AnswerWindowRecord | null {
  return answerWindows.find(windowRecord => windowRecord.pid === pid) ?? null
}

function findAnswerWindowByRunId(runId: string): AnswerWindowRecord | null {
  return answerWindows.find(windowRecord => windowRecord.runId === runId) ?? null
}

async function stopAnswerProcess(windowRecord: AnswerWindowRecord): Promise<void> {
  const pid = windowRecord.pid
  windowRecord.pid = null
  windowRecord.runId = null
  if (!pid || hostClient === null || !hostClient.isConnected()) return
  try {
    await hostClient.call('proc.kill', { pid, archive: false })
  } catch {}
}

function disposeAllAnswerProcesses(): void {
  for (let index = 0; index < answerWindows.length; index++) {
    void stopAnswerProcess(answerWindows[index]!)
  }
}

function setAskPanelVisible(visible: boolean): void {
  askPanel.hidden = !visible
  askPanel.classList.toggle('ask-panel-visible', visible)
}

function renderBriefTelemetry(brief: HudBriefContext): void {
  askTelemetry.replaceChildren()
  const fragment = document.createDocumentFragment()

  for (let index = 0; index < brief.briefData.length; index++) {
    const item = brief.briefData[index]!
    const row = document.createElement('div')
    row.className = 'ask-telemetry-row'

    const label = document.createElement('span')
    label.className = 'ask-telemetry-label'
    label.textContent = item.label

    const value = document.createElement('span')
    value.textContent = item.value

    row.append(label, value)
    fragment.appendChild(row)
  }

  askTelemetry.appendChild(fragment)
}

function getCssPixelVariable(name: string): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

function getProjectedViewportBounds(): { left: number, top: number, right: number, bottom: number } {
  const viewport = window.visualViewport
  const width = Math.max(1, Math.round(viewport?.width ?? page.clientWidth ?? window.innerWidth))
  const height = Math.max(1, Math.round(viewport?.height ?? page.clientHeight ?? window.innerHeight))
  const margin = 14

  return {
    left: getCssPixelVariable('--safe-left') + margin,
    top: getCssPixelVariable('--safe-top') + margin,
    right: width - getCssPixelVariable('--safe-right') - margin,
    bottom: height - getCssPixelVariable('--safe-bottom') - margin,
  }
}

function getRectFromCenter(centerX: number, centerY: number, halfWidth: number, halfHeight: number): ScreenRect {
  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    right: centerX + halfWidth,
    bottom: centerY + halfHeight,
  }
}

function getRectOverlapArea(a: ScreenRect, b: ScreenRect, gap = 18): number {
  const left = Math.max(a.left, b.left - gap)
  const top = Math.max(a.top, b.top - gap)
  const right = Math.min(a.right, b.right + gap)
  const bottom = Math.min(a.bottom, b.bottom + gap)
  if (right <= left || bottom <= top) return 0
  return (right - left) * (bottom - top)
}

function buildPlacementOffsets(maxRadius: number): Array<{ x: number, y: number }> {
  const offsets: Array<{ x: number, y: number }> = []

  for (let radius = 0; radius <= maxRadius; radius++) {
    if (radius === 0) {
      offsets.push({ x: 0, y: 0 })
      continue
    }

    const ring: Array<{ x: number, y: number }> = []
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue
        ring.push({ x, y })
      }
    }

    ring.sort((a, b) => (a.x * a.x + a.y * a.y) - (b.x * b.x + b.y * b.y))
    offsets.push(...ring)
  }

  return offsets
}

const panelPlacementOffsets = buildPlacementOffsets(5)

function getHudObstacleRects(): ScreenRect[] {
  if (!page.classList.contains('flight-active')) return []

  const rects: ScreenRect[] = []
  for (let index = 0; index < hudObstacleElements.length; index++) {
    const element = hudObstacleElements[index]!
    if (element.hidden) continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    rects.push({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    })
  }
  return rects
}

function applyProjectedElement(
  element: HTMLElement,
  projection: WorldPanelProjection | null,
  occupiedRects: ScreenRect[],
): ScreenRect | null {
  if (projection === null || !projection.visible) {
    element.hidden = true
    return null
  }

  element.hidden = false
  const scale = Number.isFinite(projection.scale) ? projection.scale : 1
  const bounds = getProjectedViewportBounds()
  const halfWidth = (element.offsetWidth * scale) * 0.5
  const halfHeight = (element.offsetHeight * scale) * 0.5
  const minX = bounds.left + halfWidth
  const maxX = bounds.right - halfWidth
  const minY = bounds.top + halfHeight
  const maxY = bounds.bottom - halfHeight
  const baseX = minX <= maxX
    ? clamp(projection.screenX, minX, maxX)
    : (bounds.left + bounds.right) * 0.5
  const baseY = minY <= maxY
    ? clamp(projection.screenY, minY, maxY)
    : (bounds.top + bounds.bottom) * 0.5
  const stepX = Math.max(28, element.offsetWidth * scale * 0.34)
  const stepY = Math.max(24, element.offsetHeight * scale * 0.3)

  let placedRect: ScreenRect | null = null
  let fallbackRect = getRectFromCenter(baseX, baseY, halfWidth, halfHeight)
  let fallbackScore = Number.POSITIVE_INFINITY

  for (let index = 0; index < panelPlacementOffsets.length; index++) {
    const offset = panelPlacementOffsets[index]!
    const centerX = minX <= maxX
      ? clamp(baseX + offset.x * stepX, minX, maxX)
      : (bounds.left + bounds.right) * 0.5
    const centerY = minY <= maxY
      ? clamp(baseY + offset.y * stepY, minY, maxY)
      : (bounds.top + bounds.bottom) * 0.5
    const candidateRect = getRectFromCenter(centerX, centerY, halfWidth, halfHeight)
    let overlapArea = 0
    for (let rectIndex = 0; rectIndex < occupiedRects.length; rectIndex++) {
      overlapArea += getRectOverlapArea(candidateRect, occupiedRects[rectIndex]!)
    }

    const distancePenalty = Math.hypot(centerX - baseX, centerY - baseY)
    const score = overlapArea * 4 + distancePenalty
    if (score < fallbackScore) {
      fallbackScore = score
      fallbackRect = candidateRect
    }
    if (overlapArea === 0) {
      placedRect = candidateRect
      break
    }
  }

  const finalRect = placedRect ?? fallbackRect

  element.style.left = `${(finalRect.left + finalRect.right) * 0.5}px`
  element.style.top = `${(finalRect.top + finalRect.bottom) * 0.5}px`
  element.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`
  return finalRect
}

function getPanelProjection(panels: readonly WorldPanelProjection[], id: number, kind: WorldPanelProjection['kind']): WorldPanelProjection | null {
  return panels.find(panel => panel.id === id && panel.kind === kind) ?? null
}

function closeAnswerWindow(id: number): void {
  const index = answerWindows.findIndex(windowRecord => windowRecord.id === id)
  if (index === -1) return
  const [windowRecord] = answerWindows.splice(index, 1)
  clearAnswerWindowTimer(windowRecord!)
  postWorkerMessage({ type: 'close-answer-panel', id })
  windowRecord!.root.remove()
}

function createAnswerWindow(question: string, brief: HudBriefContext): AnswerWindowRecord {
  const root = document.createElement('div')
  root.className = 'answer-window'
  root.hidden = true
  root.style.setProperty('--window-accent', toCssColor(brief.accent, 0.82))

  const head = document.createElement('div')
  head.className = 'answer-window-head'

  const meta = document.createElement('div')
  meta.className = 'answer-window-meta'

  const kicker = document.createElement('span')
  kicker.className = 'answer-window-kicker'
  kicker.textContent = getBodyDisplayName(brief.name)

  const title = document.createElement('h3')
  title.className = 'answer-window-title'
  title.textContent = question

  const context = document.createElement('span')
  context.className = 'answer-window-context'
  context.textContent = `${brief.kind} · ${simulationDateLongFormatter.format(new Date(currentSimulationTimeMs))}`

  meta.append(kicker, title, context)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'answer-window-close'
  closeButton.setAttribute('aria-label', `Close answer about ${getBodyDisplayName(brief.name)}`)
  closeButton.textContent = '×'

  const questionLabel = document.createElement('p')
  questionLabel.className = 'answer-window-question'
  questionLabel.textContent = 'Response'

  const body = document.createElement('div')
  body.className = 'answer-window-body'

  const answer = document.createElement('p')
  answer.className = 'answer-window-answer'

  body.appendChild(answer)
  head.append(meta, closeButton)
  root.append(head, questionLabel, body)

  const windowRecord: AnswerWindowRecord = {
    id: nextAnswerWindowId++,
    root,
    answer,
    timerId: null,
    pid: null,
    runId: null,
    receivedText: false,
  }

  closeButton.addEventListener('click', () => {
    void stopAnswerProcess(windowRecord)
    closeAnswerWindow(windowRecord.id)
  })

  root.addEventListener('pointerdown', () => {
    postWorkerMessage({ type: 'clear-keys' })
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  })

  answerLayer.appendChild(root)
  answerWindows.push(windowRecord)
  return windowRecord
}

function streamAnswerWindow(windowRecord: AnswerWindowRecord, answerText: string): void {
  clearAnswerWindowTimer(windowRecord)
  windowRecord.answer.textContent = ''
  windowRecord.receivedText = answerText.length > 0
  let cursor = 0

  const tick = (): void => {
    cursor = Math.min(answerText.length, cursor + (answerText[cursor] === ' ' ? 2 : 3))
    windowRecord.answer.textContent = answerText.slice(0, cursor)
    if (cursor >= answerText.length) {
      windowRecord.timerId = null
      return
    }
    windowRecord.timerId = window.setTimeout(tick, 18)
  }

  tick()
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true
  if (target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && target.isContentEditable
}

function isAskPanelFocused(): boolean {
  const activeElement = document.activeElement
  return activeElement instanceof HTMLElement && (askPanel.contains(activeElement) || answerLayer.contains(activeElement))
}

function syncAskPanelContext(): void {
  if (activeBrief === null) return
  const bodyName = getBodyDisplayName(activeBrief.name)
  const dateLabel = simulationDateLongFormatter.format(new Date(currentSimulationTimeMs))
  askTitle.textContent = `Ask about ${bodyName}`
  askContext.textContent = `${activeBrief.kind} · ${dateLabel}`
  askSummary.textContent = activeBrief.summary
  renderBriefTelemetry(activeBrief)
  askInput.placeholder = `Ask about ${bodyName}`
  askPanel.style.setProperty('--ask-accent', toCssColor(activeBrief.accent, 0.82))
}

function createQuestionFromInput(input: string, brief: HudBriefContext): string {
  const normalized = input.trim().replace(/\?+$/, '')
  if (normalized.length === 0) return ''
  const bodyName = getBodyDisplayName(brief.name)
  const lower = normalized.toLowerCase()

  if (
    lower.startsWith('why') ||
    lower.startsWith('how') ||
    lower.startsWith('what') ||
    lower.startsWith('where') ||
    lower.startsWith('when') ||
    lower.startsWith('does') ||
    lower.startsWith('is') ||
    lower.startsWith('can')
  ) {
    return `${normalized}?`
  }

  return `How does ${normalized} relate to ${bodyName}?`
}

function generateMockSuggestions(brief: HudBriefContext, input: string): string[] {
  const bodyName = getBodyDisplayName(brief.name)
  const lower = input.trim().toLowerCase()
  const day = getBriefFact(brief, 'day') ?? getBriefFact(brief, 'rotation')
  const year = getBriefFact(brief, 'year') ?? getBriefFact(brief, 'orbit')
  const gravity = getBriefFact(brief, 'gravity')
  const primary = getBriefFact(brief, 'primary')
  const suggestions: string[] = []

  if (lower.includes('day') || lower.includes('spin') || lower.includes('rotate')) {
    suggestions.push(`How long is a day on ${bodyName}?`)
  }
  if (lower.includes('year') || lower.includes('orbit') || lower.includes('sun') || lower.includes('distance')) {
    suggestions.push(
      brief.bodyType === 'moon' && primary !== null
        ? `How long does ${bodyName} take to orbit ${primary}?`
        : `How long is a year on ${bodyName}?`,
    )
    suggestions.push(`Where is ${bodyName} in the current ephemeris snapshot?`)
  }
  if (lower.includes('gravity') || lower.includes('weight') || lower.includes('heavy')) {
    suggestions.push(`How strong is gravity on ${bodyName}?`)
  }
  if (lower.includes('color') || lower.includes('blue') || lower.includes('red') || lower.includes('cloud') || lower.includes('look')) {
    suggestions.push(`Why does ${bodyName} look the way it does?`)
  }
  if (lower.includes('tilt') || lower.includes('season')) {
    suggestions.push(`What does ${bodyName}'s tilt change?`)
  }
  if (lower.includes('ring')) {
    suggestions.push(
      brief.id === 'saturn'
        ? `What are Saturn's rings made of?`
        : `Does ${bodyName} have rings or nearby debris?`,
    )
  }
  if (lower.length >= 3) {
    suggestions.push(createQuestionFromInput(input, brief))
  }

  suggestions.push(`Why does ${bodyName} look the way it does?`)
  if (day !== null) suggestions.push(`How long is a day on ${bodyName}?`)
  if (gravity !== null) suggestions.push(`How strong is gravity on ${bodyName}?`)
  if (brief.bodyType === 'moon' && primary !== null) {
    suggestions.push(`What is ${bodyName}'s relationship to ${primary}?`)
  } else if (year !== null) {
    suggestions.push(`How long is a year on ${bodyName}?`)
  }

  if (brief.id === 'earth') suggestions.push('What causes seasons on Earth?')
  if (brief.id === 'sun') suggestions.push('How does the Sun power the rest of the system?')
  if (brief.id === 'saturn') suggestions.push(`What are Saturn's rings made of?`)
  if (brief.bodyType === 'moon') suggestions.push(`What keeps ${bodyName} bound to its primary?`)
  suggestions.push(`What makes ${bodyName} special in this scene?`)

  return Array.from(new Set(suggestions.filter(question => question.length > 0))).slice(0, 4)
}

function renderSuggestionButtons(questions: string[]): void {
  askSuggestions.replaceChildren()
  const fragment = document.createDocumentFragment()

  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]!
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ask-suggestion'
    button.textContent = question
    button.addEventListener('click', () => {
      askInput.value = question
      submitAskQuestion(question)
    })
    fragment.appendChild(button)
  }

  askSuggestions.appendChild(fragment)
}

function scheduleSuggestionRefresh(immediate = false): void {
  clearSuggestionTimer()
  if (activeBrief === null) return

  const refresh = (): void => {
    suggestionTimer = null
    renderSuggestionButtons(generateMockSuggestions(activeBrief!, askInput.value))
  }

  if (immediate) {
    refresh()
    return
  }

  suggestionTimer = window.setTimeout(refresh, 280)
}

function buildMockAnswer(question: string, brief: HudBriefContext): string {
  const lower = question.toLowerCase()
  const bodyName = getBodyDisplayName(brief.name)
  const day = getBriefFact(brief, 'day') ?? getBriefFact(brief, 'rotation')
  const year = getBriefFact(brief, 'year') ?? getBriefFact(brief, 'orbit')
  const gravity = getBriefFact(brief, 'gravity')
  const tilt = getBriefFact(brief, 'tilt')
  const primary = getBriefFact(brief, 'primary')
  const distance = getBriefFact(brief, 'distance')
  const dateLabel = simulationDateLongFormatter.format(new Date(currentSimulationTimeMs))

  if (lower.includes('ring')) {
    if (brief.id === 'saturn') {
      return `Saturn's rings are mostly icy particles with darker rocky material mixed in. In this demo they are rendered as a dense particle belt, which is why they read as a real structure instead of a flat painted disk.`
    }
    return `${bodyName} is not the ring showcase in this scene. The renderer gives the dedicated asteroid-ring treatment to Saturn, so ${bodyName} is better read through its surface, orbit, and gravity telemetry.`
  }

  if (lower.includes('gravity') || lower.includes('weight') || lower.includes('heavy')) {
    if (gravity !== null) {
      return `${bodyName} has a listed surface gravity of about ${gravity}. That single number is the quickest cue for how heavy you would feel there compared with the bodies around it.`
    }
    return `${bodyName} does not have a gravity figure exposed in this brief yet, so the best context here is its body class and physical scale: ${brief.summary}`
  }

  if (lower.includes('day') || lower.includes('spin') || lower.includes('rotate')) {
    if (day !== null) {
      return `${bodyName} rotates in about ${day}. ${tilt !== null ? `Its axial tilt is about ${tilt}, which helps determine how sunlight is distributed across the world.` : brief.summary}`
    }
    return `${bodyName} is not carrying a day-length readout in this brief, but it is still being rendered with a body-fixed orientation for the current snapshot.`
  }

  if (lower.includes('year') || lower.includes('orbit') || lower.includes('distance') || lower.includes('sun')) {
    if (brief.bodyType === 'moon' && primary !== null) {
      return `${bodyName} is modeled here as a moon of ${primary}. Its orbital brief reads ${year ?? 'from the current snapshot'}${distance !== null ? ` at roughly ${distance}` : ''}, while the display distances in the scene are compressed so you can actually navigate the system.`
    }
    if (year !== null) {
      return `${bodyName} takes about ${year} to complete an orbit. The arrangement you are seeing is frozen to the ephemeris snapshot dated ${dateLabel}, so this scene is a readable snapshot rather than a live time-lapse.`
    }
    return `${bodyName} is being shown in the ephemeris snapshot for ${dateLabel}. In this demo the important idea is relative placement and lighting, not literal travel time at real solar-system scale.`
  }

  if (lower.includes('tilt') || lower.includes('season')) {
    if (tilt !== null) {
      return `${bodyName}'s tilt is about ${tilt}. Larger tilts usually produce stronger seasonal swings because one hemisphere leans toward the Sun and then away again over the course of an orbit.`
    }
    return `${bodyName} is not carrying a tilt figure in this brief, so the most reliable description here is its visible character: ${brief.summary}`
  }

  if (lower.includes('color') || lower.includes('blue') || lower.includes('red') || lower.includes('yellow') || lower.includes('cloud') || lower.includes('look')) {
    return `${brief.summary} That visual read is exactly what the renderer is trying to preserve, then the telemetry adds the physical numbers that make the appearance meaningful.`
  }

  if (lower.includes('life') || lower.includes('habitable')) {
    if (brief.id === 'earth') {
      return `Earth is the only body in this scene known to support life. Liquid water, a stable atmosphere, and temperate surface conditions are the core reasons it stands apart from the rest of the system.`
    }
    return `${bodyName} is not framed here as a living world. In this guide it is better understood through its orbit, gravity, atmosphere or surface signature, and its place in the wider system snapshot.`
  }

  if (lower.includes('moon')) {
    if (brief.bodyType === 'planet') {
      return `${bodyName} sits inside a larger moon system, but this scene renders only a curated set so navigation stays readable. The brief is meant to give you the main physical cues first, then let follow-up questions dig deeper.`
    }
    if (primary !== null) {
      return `${bodyName} is gravitationally bound to ${primary}. Its orbit and distance telemetry are the key clues for understanding how it moves through that local system.`
    }
  }

  const telemetrySummary = brief.briefData
    .slice(0, 3)
    .map(item => `${item.label} ${item.value}`)
    .join(', ')

  return `${bodyName} is presented here as a ${brief.kind}. ${brief.summary} For a fast physical read, start with ${telemetrySummary}.`
}

function buildGuidePrompt(question: string, brief: HudBriefContext): string {
  const telemetry = brief.briefData
    .map(item => `- ${item.label}: ${item.value}`)
    .join('\n')
  const snapshotDate = simulationDateLongFormatter.format(new Date(currentSimulationTimeMs))

  return [
    'You are a concise astronomy guide embedded in an interactive starfield app.',
    'Answer the user question using the provided body brief and snapshot context only.',
    'If the brief does not include the needed fact, say that directly and reason from what is available.',
    'Keep the tone factual and the answer short. No markdown bullets unless needed.',
    '',
    `Body name: ${getBodyDisplayName(brief.name)}`,
    `Kind: ${brief.kind}`,
    `Body type: ${brief.bodyType}`,
    `Snapshot date: ${snapshotDate}`,
    `Summary: ${brief.summary}`,
    'Telemetry:',
    telemetry || '- none',
    '',
    `User question: ${question}`,
  ].join('\n')
}

async function requestLiveAnswer(windowRecord: AnswerWindowRecord, question: string, brief: HudBriefContext): Promise<void> {
  if (hostClient === null || !hostClient.isConnected()) {
    streamAnswerWindow(windowRecord, buildMockAnswer(question, brief))
    return
  }

  windowRecord.answer.textContent = 'Thinking…'
  windowRecord.receivedText = false

  try {
    const spawnResult = await hostClient.spawnProcess({
      profile: 'app',
      label: `${getBodyDisplayName(brief.name)} guide`,
      workspace: { mode: 'none' },
    })
    if (!spawnResult.ok) {
      throw new Error('error' in spawnResult ? spawnResult.error : 'process spawn failed')
    }

    windowRecord.pid = spawnResult.pid

    const sendResult = await hostClient.sendMessage(buildGuidePrompt(question, brief), spawnResult.pid)
    if (!sendResult.ok) {
      throw new Error('error' in sendResult ? sendResult.error : 'message send failed')
    }

    windowRecord.runId = sendResult.runId
  } catch (error) {
    windowRecord.answer.textContent = `Live guide unavailable: ${error instanceof Error ? error.message : String(error)}`
    await stopAnswerProcess(windowRecord)
  }
}

function submitAskQuestion(questionText: string): void {
  if (activeBrief === null) return
  const brief = activeBrief
  const question = questionText.trim()
  if (question.length === 0) return
  const windowRecord = createAnswerWindow(question, brief)
  postWorkerMessage({ type: 'open-answer-panel', id: windowRecord.id, bodyId: brief.id })
  void requestLiveAnswer(windowRecord, question, brief)
  askInput.value = ''
  scheduleSuggestionRefresh(true)
}

function setBriefContext(brief: HudBriefContext | null): void {
  const previousId = activeBrief?.id ?? null
  const nextId = brief?.id ?? null

  activeBrief = brief

  if (brief === null) {
    clearSuggestionTimer()
    if (askPanel.contains(document.activeElement)) {
      askInput.blur()
    }
    setAskPanelVisible(false)
    askInput.value = ''
    askSummary.textContent = ''
    askTelemetry.replaceChildren()
    askSuggestions.replaceChildren()
    askSubmitButton.disabled = true
    askInput.disabled = true
    return
  }

  syncAskPanelContext()
  askSubmitButton.disabled = false
  askInput.disabled = false
  setAskPanelVisible(true)

  if (previousId !== nextId) {
    askInput.value = ''
    scheduleSuggestionRefresh(true)
  }
}

function bindVirtualStick(
  zone: HTMLDivElement,
  knob: HTMLDivElement,
  applyAxes: (x: number, y: number) => void,
): void {
  let activePointerId: number | null = null

  const reset = (): void => {
    activePointerId = null
    knob.style.transform = 'translate(-50%, -50%)'
    zone.classList.remove('touch-stick-active')
    applyAxes(0, 0)
  }

  const updateFromPoint = (clientX: number, clientY: number): void => {
    const rect = zone.getBoundingClientRect()
    const centerX = rect.left + rect.width * 0.5
    const centerY = rect.top + rect.height * 0.5
    const limit = Math.max(20, Math.min(rect.width, rect.height) * 0.5 - knob.clientWidth * 0.5 - 8)
    let x = (clientX - centerX) / limit
    let y = (centerY - clientY) / limit
    const length = Math.hypot(x, y)
    if (length > 1) {
      x /= length
      y /= length
    }
    if (Math.hypot(x, y) < 0.08) {
      x = 0
      y = 0
    }
    knob.style.transform = `translate(calc(-50% + ${x * limit}px), calc(-50% + ${-y * limit}px))`
    applyAxes(clamp(x, -1, 1), clamp(y, -1, 1))
  }

  zone.addEventListener('pointerdown', event => {
    event.preventDefault()
    activePointerId = event.pointerId
    zone.classList.add('touch-stick-active')
    zone.setPointerCapture(event.pointerId)
    updateFromPoint(event.clientX, event.clientY)
  })

  zone.addEventListener('pointermove', event => {
    if (event.pointerId !== activePointerId) return
    event.preventDefault()
    updateFromPoint(event.clientX, event.clientY)
  })

  const release = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return
    event.preventDefault()
    reset()
  }

  zone.addEventListener('pointerup', release)
  zone.addEventListener('pointercancel', release)
}

function bindHoldButton(
  button: HTMLButtonElement,
  onChange: (pressed: boolean) => void,
): void {
  let activePointerId: number | null = null

  button.addEventListener('pointerdown', event => {
    event.preventDefault()
    activePointerId = event.pointerId
    button.classList.add('touch-action-active')
    button.setPointerCapture(event.pointerId)
    onChange(true)
  })

  const release = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return
    event.preventDefault()
    activePointerId = null
    button.classList.remove('touch-action-active')
    onChange(false)
  }

  button.addEventListener('pointerup', release)
  button.addEventListener('pointercancel', release)
}

function updateHud(snapshot: HudSnapshot): void {
  currentSimulationTimeMs = snapshot.timeMs
  const speedValue = Number.isFinite(snapshot.speed) ? snapshot.speed : 0
  const speed = `${speedValue.toFixed(1)}u/s`
  const date = simulationDateFormatter.format(new Date(snapshot.timeMs))
  if (speedometer.textContent !== speed) speedometer.textContent = speed
  if (simDate.textContent !== date) simDate.textContent = date

  const previousBriefId = activeBrief?.id ?? null
  const nextBriefId = snapshot.brief?.id ?? null
  if (previousBriefId !== nextBriefId) {
    if (snapshot.brief !== null && document.pointerLockElement === canvas) {
      document.exitPointerLock()
      postWorkerMessage({ type: 'clear-keys' })
    }
    setBriefContext(snapshot.brief)
  } else if (snapshot.brief !== null) {
    activeBrief = snapshot.brief
    syncAskPanelContext()
  }

  const briefPanel = getPanelProjection(snapshot.panels, 0, 'brief')
  const occupiedRects = getHudObstacleRects()
  const briefRect = applyProjectedElement(askPanel, activeBrief === null ? null : briefPanel, occupiedRects)
  if (briefRect !== null) occupiedRects.push(briefRect)

  for (let index = 0; index < answerWindows.length; index++) {
    const windowRecord = answerWindows[index]!
    const answerRect = applyProjectedElement(windowRecord.root, getPanelProjection(snapshot.panels, windowRecord.id, 'answer'), occupiedRects)
    if (answerRect !== null) occupiedRects.push(answerRect)
  }
}

function setFlightStarted(started: boolean): void {
  flightStarted = started
  page.classList.toggle('flight-active', started)
  introScreen.classList.toggle('intro-hidden', started)
  introScreen.setAttribute('aria-hidden', started ? 'true' : 'false')
  if (!started) {
    introScreen.hidden = false
    setBriefContext(null)
  }
}

async function beginFlight(): Promise<void> {
  if (flightStarted) return
  setFlightStarted(true)
  introStartButton.disabled = true
  introStartButton.blur()
  postWorkerMessage({ type: 'clear-keys' })
  postWorkerMessage({ type: 'flight-started' })

  window.setTimeout(() => {
    introScreen.hidden = true
  }, 260)

  if (prefersTouchControls || document.pointerLockElement === canvas) return
  try {
    await canvas.requestPointerLock()
  } catch {
    postWorkerMessage({ type: 'pointer-lock-notice', text: 'click to lock pointer', durationMs: 1600 })
  }
}

function renderLoop(timestamp: number): void {
  if (initialized && !framePending) {
    framePending = true
    postWorkerMessage({ type: 'frame', timestamp })
  }
  requestAnimationFrame(renderLoop)
}

function bindEvents(): void {
  canvas.addEventListener('click', async () => {
    if (!flightStarted) return
    if (prefersTouchControls) return
    if (document.pointerLockElement === canvas) return
    try {
      await canvas.requestPointerLock()
    } catch {
      postWorkerMessage({ type: 'pointer-lock-notice', text: 'pointer unlock cooldown; click again', durationMs: 1800 })
    }
  })

  document.addEventListener('pointerlockchange', () => {
    postWorkerMessage({ type: 'pointer-lock', locked: document.pointerLockElement === canvas })
  })

  document.addEventListener('mousemove', event => {
    if (document.pointerLockElement !== canvas) return
    postWorkerMessage({ type: 'pointer-move', movementX: event.movementX, movementY: event.movementY })
  })

  window.addEventListener('keydown', event => {
    if (!flightStarted) return
    if (isTextEntryTarget(event.target) || isAskPanelFocused()) return
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault()
    postWorkerMessage({ type: 'keydown', code: event.code, repeat: event.repeat })
  })

  window.addEventListener('keyup', event => {
    if (!flightStarted) return
    if (isTextEntryTarget(event.target) || isAskPanelFocused()) return
    postWorkerMessage({ type: 'keyup', code: event.code })
  })

  window.addEventListener('blur', () => {
    postWorkerMessage({ type: 'clear-keys' })
    clearTouchControls()
  })

  window.addEventListener('pagehide', () => {
    disposeAllAnswerProcesses()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      postWorkerMessage({ type: 'clear-keys' })
      clearTouchControls()
    }
  })

  window.addEventListener('resize', () => {
    postResizeAfterLayout()
  })

  window.visualViewport?.addEventListener('resize', () => {
    postResizeAfterLayout()
  })

  window.visualViewport?.addEventListener('scroll', () => {
    syncViewportCssVariables()
  })

  bindVirtualStick(touchMoveZone, touchMoveKnob, (x, y) => {
    touchState.moveX = x
    touchState.moveY = y
    postTouchControls()
  })

  bindVirtualStick(touchLookZone, touchLookKnob, (x, y) => {
    touchState.lookX = x
    touchState.lookY = y
    postTouchControls()
  })

  bindHoldButton(touchLiftUpButton, pressed => {
    touchLiftUpPressed = pressed
    if (pressed) touchLiftUpButton.classList.add('touch-action-active')
    updateTouchLift()
  })

  bindHoldButton(touchLiftDownButton, pressed => {
    touchLiftDownPressed = pressed
    if (pressed) touchLiftDownButton.classList.add('touch-action-active')
    updateTouchLift()
  })

  bindHoldButton(touchBrakeButton, pressed => {
    touchState.braking = pressed
    if (pressed) touchBrakeButton.classList.add('touch-action-active')
    postTouchControls()
  })

  let briefPointerId: number | null = null
  touchBriefButton.addEventListener('pointerdown', event => {
    event.preventDefault()
    briefPointerId = event.pointerId
    touchBriefButton.classList.add('touch-action-active')
    touchBriefButton.setPointerCapture(event.pointerId)
    postWorkerMessage({ type: 'touch-activate' })
  })

  const releaseBrief = (event: PointerEvent): void => {
    if (event.pointerId !== briefPointerId) return
    event.preventDefault()
    briefPointerId = null
    touchBriefButton.classList.remove('touch-action-active')
  }
  touchBriefButton.addEventListener('pointerup', releaseBrief)
  touchBriefButton.addEventListener('pointercancel', releaseBrief)

  introStartButton.addEventListener('click', () => {
    void beginFlight()
  })

  askPanel.addEventListener('pointerdown', () => {
    postWorkerMessage({ type: 'clear-keys' })
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  })

  askInput.addEventListener('focus', () => {
    postWorkerMessage({ type: 'clear-keys' })
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  })

  askInput.addEventListener('input', () => {
    scheduleSuggestionRefresh(false)
  })

  askForm.addEventListener('submit', event => {
    event.preventDefault()
    if (activeBrief === null) return
    submitAskQuestion(createQuestionFromInput(askInput.value, activeBrief))
  })
}

worker.addEventListener('message', event => {
  const message = event.data as WorkerSnapshotMessage
  if (message.type !== 'snapshot') return
  framePending = false
  const now = performance.now()
  if (lastSnapshotAt !== 0) {
    const instantFps = 1000 / Math.max(1, now - lastSnapshotAt)
    smoothedFps = smoothedFps === 0 ? instantFps : smoothedFps * 0.82 + instantFps * 0.18
    fps.textContent = smoothedFps.toFixed(1)
  }
  lastSnapshotAt = now
  updateHud(message.hud)
})

async function main(): Promise<void> {
  syncViewportCssVariables()
  setFlightStarted(false)
  bindEvents()
  hostClient = await connectHostClient().catch(() => null)
  if (hostClient !== null) {
    hostClient.onSignal((signal, payload) => {
      const record = asRecord(payload)
      const pid = asString(record?.pid)
      const runId = asString(record?.runId)
      const windowRecord = (runId ? findAnswerWindowByRunId(runId) : null) ?? (pid ? findAnswerWindowByPid(pid) : null)
      if (windowRecord === null) return

      if (signal === 'chat.text') {
        const text = asString(record?.text) ?? ''
        if (text.length === 0) return
        clearAnswerWindowTimer(windowRecord)
        if (!windowRecord.receivedText) {
          windowRecord.answer.textContent = ''
          windowRecord.receivedText = true
        }
        windowRecord.answer.textContent += text
        return
      }

      if (signal === 'chat.complete') {
        const text = asString(record?.text)
        if (text && (!windowRecord.receivedText || text.length >= windowRecord.answer.textContent.length)) {
          clearAnswerWindowTimer(windowRecord)
          windowRecord.answer.textContent = text
          windowRecord.receivedText = true
        } else if (!windowRecord.receivedText) {
          windowRecord.answer.textContent = 'No answer returned.'
        }
        void stopAnswerProcess(windowRecord)
        return
      }

      if (signal === 'process.exit' && !windowRecord.receivedText) {
        windowRecord.answer.textContent = 'Guide process exited before returning an answer.'
        void stopAnswerProcess(windowRecord)
      }
    })
  }
  await document.fonts.ready

  worker.postMessage(
    {
      type: 'init',
      canvas: offscreenCanvas,
      minimap: offscreenMinimap,
      viewport: getViewport(),
    } satisfies WorkerInitMessage,
    [offscreenCanvas, offscreenMinimap],
  )

  initialized = true
  requestAnimationFrame(renderLoop)
}

void main()
