/// <reference path="./pretext.d.ts" />

import { layoutWithLines, prepareWithSegments, walkLineRanges } from "@chenglou/pretext"

const FONT_WEIGHT = 500
const FONT_FAMILY = '"IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 24
const LINE_HEIGHT_RATIO = 1.18
const H_PADDING = 0
const V_PADDING = 0
const SAMPLE_COLUMNS = 64
const TEMPLATE_ROW = 'M'.repeat(SAMPLE_COLUMNS)
const CLASSIC_ASCII_CANDIDATES = Array.from(
  new Set(',.;:@!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),
)
const MAX_CELL_COUNT = 18_000
const MIN_COLS = 64
const MIN_ROWS = 24
const HORIZONTAL_FOV_DEGREES = 76
const NEAR_Z = 0.08
const MAX_DT = 0.04
const TRAIL_GAIN = 1.9
const OUTSIDE_MARGIN = 4
const BASE_MOVE_SPEED = 180
const BOOST_MULTIPLIER = 3
const MOVE_ACCELERATION_RESPONSE = 7.5
const LOOK_SENSITIVITY = 0.0021
const KEY_LOOK_SPEED = 1.45
const CAMERA_COLLISION_MARGIN = 0.8
const STAR_DEPTH = 100_000
const JULIAN_DAY_MS = 86_400_000
const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12, 0, 0, 0)
const ORBIT_DISTANCE_EXPONENT = 0.37
const ORBIT_DISTANCE_SCALE = 4.5
const STAR_RADIUS_EXPONENT = 0.6
const SUN_CENTER_WORLD = { x: -140, y: 52, z: -170 } as const
const EARTH_RENDER_RADIUS = 11.5
const SUN_RADIUS = getCompressedStarRadiusFromEarths(109.2)
const SUN_COLOR = { r: 1, g: 0.95, b: 0.86 } as const
const SUN_CORE_SCALE = 1.35
const SUN_CORONA_SCALE = 1.58
const SCENE_EXPOSURE = 1.42
const SOLAR_VISUAL_FALLOFF_EXPONENT = 0.18
const PLANET_CENTER_WORLD = { x: 4.5, y: -1.3, z: 48 } as const
const WORLD_UP = { x: 0, y: 1, z: 0 } as const
const INFO_FONT_SIZE = 13
const INFO_FONT = `${FONT_WEIGHT} ${INFO_FONT_SIZE}px ${FONT_FAMILY}`
const INFO_LINE_HEIGHT = 16
const INFO_CARD_WIDTH = 312
const INFO_BADGE_WIDTH = 146
const INFO_BADGE_HEIGHT = 34
const INFO_CARD_PADDING = 12
const INFO_CARD_MARGIN = 14
const INFO_POINTER_OFFSET = 26
const GUIDE_FONT_SIZE = 10
const GUIDE_FONT = `600 ${GUIDE_FONT_SIZE}px ${FONT_FAMILY}`
const GUIDE_HEIGHT = 22
const GUIDE_PADDING_X = 8
const GUIDE_EDGE_INSET = 18
const GUIDE_LABEL_GAP = 12
const BRIEF_PROMPT_SPEED_MAX = 18
const BRIEF_TARGET_DISTANCE_MULTIPLIER = 2.4
const BRIEF_REVEAL_SPEED = 5.2
const BRIEF_MEASURE_OFFSET = 34
const FLOATING_PANEL_FORWARD = 44
const FLOATING_PANEL_LATERAL = 18
const FLOATING_PANEL_VERTICAL = 10
const FLOATING_PANEL_SCALE_DISTANCE = 56
const FLOATING_PANEL_MIN_SCALE = 0.24
const FLOATING_PANEL_MAX_SCALE = 1.16
const TIME_WARP_OPTIONS = [
  { label: 'paused', daysPerSecond: 0 },
  { label: '1h/s', daysPerSecond: 1 / 24 },
  { label: '6h/s', daysPerSecond: 0.25 },
  { label: '1d/s', daysPerSecond: 1 },
  { label: '7d/s', daysPerSecond: 7 },
  { label: '30d/s', daysPerSecond: 30 },
  { label: '90d/s', daysPerSecond: 90 },
  { label: '1y/s', daysPerSecond: 365 },
  { label: '5y/s', daysPerSecond: 365 * 5 },
] as const
const DEFAULT_TIME_WARP_INDEX = 0
const LOCKED_THRUST_MULTIPLIER = 1
const LOCKED_STAR_COUNT = 320
const SATURN_RING_PARTICLE_COUNT = 3_200
const SATURN_RING_INNER_FACTOR = 1.42
const SATURN_RING_OUTER_FACTOR = 2.9
const SATURN_RING_THICKNESS_FACTOR = 0.045
const CAMERA_START_OFFSET_FROM_EARTH = {
  x: -PLANET_CENTER_WORLD.x,
  y: -PLANET_CENTER_WORLD.y,
  z: -PLANET_CENTER_WORLD.z,
} as const
const INTEGER_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
})

type Vec3 = {
  x: number
  y: number
  z: number
}

type Rgb = {
  r: number
  g: number
  b: number
}

type DistantStar = {
  direction: Vec3
  intensity: number
  tint: Rgb
}

type RingParticle = {
  angle: number
  radiusFactor: number
  heightFactor: number
  size: number
  brightness: number
}

type InfoDatum = {
  label: string
  value: string
}

type OrbitalElements = {
  ascendingNodeBase: number
  ascendingNodeRate: number
  inclinationBase: number
  inclinationRate: number
  perihelionBase: number
  perihelionRate: number
  semiMajorAxisBase: number
  semiMajorAxisRate: number
  eccentricityBase: number
  eccentricityRate: number
  meanAnomalyBase: number
  meanAnomalyRate: number
}

type MoonOrbit = {
  parentId: string
  semiMajorAxisKm: number
  orbitalPeriodDays: number
  inclinationDegrees: number
  nodeDegrees: number
  phaseDegrees: number
  retrograde?: boolean
}

type CelestialBody = {
  id: string
  name: string
  kind: string
  bodyType: 'star' | 'planet' | 'moon'
  center: Vec3
  radius: number
  physicalRadiusKm: number
  accent: Rgb
  summary: string
  briefData: readonly InfoDatum[]
  infoDistance: number
  minScreenRadius: number
  orbit?: OrbitalElements
  moonOrbit?: MoonOrbit
}

type Projection = {
  focalX: number
  focalY: number
}

type BodyOrientationFrame = {
  meridian: Vec3
  east: Vec3
  north: Vec3
}

type Metrics = {
  font: string
  fontSize: number
  lineHeight: number
  cellWidth: number
  cols: number
  rows: number
  blockWidth: number
  blockHeight: number
  left: number
  top: number
  baselineOffset: number
  projection: Projection
}

type GridCandidate = {
  font: string
  fontSize: number
  lineHeight: number
  cellWidth: number
  cols: number
  rows: number
  blockWidth: number
  blockHeight: number
}

type GlyphEntry = {
  char: string
  width: number
  brightness: number
}

type GlyphPalette = {
  entries: GlyphEntry[]
  lookup: string[]
}

type CameraState = {
  position: Vec3
  velocity: Vec3
  yaw: number
  pitch: number
}

type CameraTransform = CameraState & {
  forward: Vec3
  right: Vec3
  up: Vec3
}

type RowRun = {
  startCol: number
  text: string
  color: string
}

type BodyOverlayTarget = {
  body: CelestialBody
  screenX: number
  screenY: number
  screenRadiusX: number
  screenRadiusY: number
  surfaceDistance: number
  focusDistance: number
}

type TouchControls = {
  moveX: number
  moveY: number
  lookX: number
  lookY: number
  lift: number
  braking: boolean
}

type HudBriefContext = {
  id: string
  name: string
  kind: string
  bodyType: CelestialBody['bodyType']
  summary: string
  accent: Rgb
  briefData: readonly InfoDatum[]
}

type HudWorldPanel = {
  id: number
  kind: 'brief' | 'answer'
  bodyId: string
  screenX: number
  screenY: number
  scale: number
  visible: boolean
}

type FloatingPanel = {
  id: number
  kind: 'brief' | 'answer'
  bodyId: string
  anchor: Vec3
}

type HudSnapshot = {
  speed: number
  timeMs: number
  brief: HudBriefContext | null
  panels: HudWorldPanel[]
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

type WorkerResizeMessage = {
  type: 'resize'
  viewport: WorkerViewport
}

type WorkerFrameMessage = {
  type: 'frame'
  timestamp: number
}

type WorkerFlightStartedMessage = {
  type: 'flight-started'
}

type WorkerKeyMessage = {
  type: 'keydown' | 'keyup'
  code: string
  repeat?: boolean
}

type WorkerPointerMoveMessage = {
  type: 'pointer-move'
  movementX: number
  movementY: number
}

type WorkerPointerLockMessage = {
  type: 'pointer-lock'
  locked: boolean
}

type WorkerPointerLockNoticeMessage = {
  type: 'pointer-lock-notice'
  text: string
  durationMs: number
}

type WorkerTouchControlsMessage = {
  type: 'touch-controls'
} & TouchControls

type WorkerTouchActivateMessage = {
  type: 'touch-activate'
}

type WorkerOpenAnswerPanelMessage = {
  type: 'open-answer-panel'
  id: number
  bodyId: string
}

type WorkerCloseAnswerPanelMessage = {
  type: 'close-answer-panel'
  id: number
}

type WorkerClearKeysMessage = {
  type: 'clear-keys'
}

type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerResizeMessage
  | WorkerFrameMessage
  | WorkerFlightStartedMessage
  | WorkerKeyMessage
  | WorkerPointerMoveMessage
  | WorkerPointerLockMessage
  | WorkerPointerLockNoticeMessage
  | WorkerTouchControlsMessage
  | WorkerTouchActivateMessage
  | WorkerOpenAnswerPanelMessage
  | WorkerCloseAnswerPanelMessage
  | WorkerClearKeysMessage

type WorkerOutboundMessage = {
  type: 'snapshot'
  hud: HudSnapshot
}

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerInboundMessage>) => void): void
  postMessage(message: WorkerOutboundMessage): void
}

const workerScope = self as unknown as WorkerScope
let mainCanvas: OffscreenCanvas | null = null
let minimapCanvas: OffscreenCanvas | null = null
let ctx!: OffscreenCanvasRenderingContext2D
let miniCtx!: OffscreenCanvasRenderingContext2D

const brightnessCanvas =
  typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas')
const brightnessContext =
  brightnessCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
if (brightnessContext === null) throw new Error('brightness context not available')
const bCtx = brightnessContext

const stars: DistantStar[] = []
const saturnRingParticles: RingParticle[] = []
const pressedKeys = new Set<string>()
const quantizedColorCache: Array<string | undefined> = Array(4096)
const guideWidthCache = new Map<string, number>()
const rowWidthCache = new Map<string, number>()
const paletteCache = new Map<string, GlyphPalette>()
const infoLineCache = new Map<string, string[]>()

const state = {
  pointerLocked: false,
  metrics: null as Metrics | null,
  palette: null as GlyphPalette | null,
  redField: new Float32Array(0),
  greenField: new Float32Array(0),
  blueField: new Float32Array(0),
  depthField: new Float32Array(0),
  flightStarted: false,
  floatingBriefPanel: null as FloatingPanel | null,
  floatingAnswerPanels: [] as FloatingPanel[],
  hudPanels: [] as HudWorldPanel[],
  camera: {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
  } satisfies CameraState,
  simulationTimeMs: Date.now(),
  orbitReferenceAngle: 0,
  briefPromptBodyId: null as string | null,
  briefOpenBodyId: null as string | null,
  briefReveal: 0,
  pointerLockNotice: '',
  pointerLockNoticeUntil: 0,
  touchControls: {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    lift: 0,
    braking: false,
  } as TouchControls,
  viewport: {
    width: 1,
    height: 1,
    minimapWidth: 200,
    minimapHeight: 200,
    dpr: 1,
  } satisfies WorkerViewport,
  lastTimestamp: 0,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  }
}

function smoothstep(min: number, max: number, value: number): number {
  const t = clamp01((value - min) / (max - min))
  return t * t * (3 - 2 * t)
}

function fract(value: number): number {
  return value - Math.floor(value)
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function lengthVec3(vec: Vec3): number {
  return Math.hypot(vec.x, vec.y, vec.z)
}

function normalizeVec3(vec: Vec3): Vec3 {
  const length = lengthVec3(vec)
  if (length === 0) return { x: 0, y: 0, z: 0 }
  return { x: vec.x / length, y: vec.y / length, z: vec.z / length }
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function subtractVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function scaleVec3(vec: Vec3, scalar: number): Vec3 {
  return { x: vec.x * scalar, y: vec.y * scalar, z: vec.z * scalar }
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function rotateVec3AroundAxis(vec: Vec3, axis: Vec3, angleRadians: number): Vec3 {
  const unitAxis = normalizeVec3(axis)
  const cosAngle = Math.cos(angleRadians)
  const sinAngle = Math.sin(angleRadians)
  return addVec3(
    addVec3(
      scaleVec3(vec, cosAngle),
      scaleVec3(crossVec3(unitAxis, vec), sinAngle),
    ),
    scaleVec3(unitAxis, dotVec3(unitAxis, vec) * (1 - cosAngle)),
  )
}

function distanceVec3(a: Vec3, b: Vec3): number {
  return lengthVec3(subtractVec3(a, b))
}

function getCurrentSpeed(): number {
  return lengthVec3(state.camera.velocity)
}

function getPlanetDisplayRadiusFromEarths(earthRadii: number): number {
  return EARTH_RENDER_RADIUS * earthRadii
}

function getCompressedStarRadiusFromEarths(earthRadii: number): number {
  return EARTH_RENDER_RADIUS * Math.pow(earthRadii, STAR_RADIUS_EXPONENT)
}

function clearPressedKeys(): void {
  pressedKeys.clear()
}

function clearTouchControls(): void {
  state.touchControls.moveX = 0
  state.touchControls.moveY = 0
  state.touchControls.lookX = 0
  state.touchControls.lookY = 0
  state.touchControls.lift = 0
  state.touchControls.braking = false
}

function hasAnyPressed(...codes: string[]): boolean {
  for (let index = 0; index < codes.length; index++) {
    if (pressedKeys.has(codes[index]!)) return true
  }
  return false
}

function findBodyById(id: string | null): CelestialBody | null {
  if (id === null) return null
  return celestialBodies.find(body => body.id === id) ?? null
}

function wrapRadians(angle: number): number {
  const turn = Math.PI * 2
  let wrapped = (angle + Math.PI) % turn
  if (wrapped < 0) wrapped += turn
  return wrapped - Math.PI
}

function gaussianLobe(
  longitude: number,
  latitude: number,
  centerLongitudeDegrees: number,
  centerLatitudeDegrees: number,
  longitudeSigmaDegrees: number,
  latitudeSigmaDegrees: number,
  amplitude: number,
): number {
  const lonDelta = wrapRadians(longitude - toRadians(centerLongitudeDegrees))
  const latDelta = latitude - toRadians(centerLatitudeDegrees)
  const lonSigma = Math.max(1e-5, toRadians(longitudeSigmaDegrees))
  const latSigma = Math.max(1e-5, toRadians(latitudeSigmaDegrees))
  return Math.exp(-(
    (lonDelta * lonDelta) / (lonSigma * lonSigma) +
    (latDelta * latDelta) / (latSigma * latSigma)
  )) * amplitude
}

const EARTH_SUN_DISTANCE = distanceVec3(PLANET_CENTER_WORLD, SUN_CENTER_WORLD)
const SOLAR_PRIMARY_AXIS = normalizeVec3(subtractVec3(PLANET_CENTER_WORLD, SUN_CENTER_WORLD))
const SOLAR_LATERAL_AXIS = normalizeVec3(crossVec3(SOLAR_PRIMARY_AXIS, WORLD_UP))
const SOLAR_VERTICAL_AXIS = normalizeVec3(crossVec3(SOLAR_LATERAL_AXIS, SOLAR_PRIMARY_AXIS))

function placeSolarBody(distance: number, phase: number, lift: number): Vec3 {
  const orbitalDirection = normalizeVec3(addVec3(
    scaleVec3(SOLAR_PRIMARY_AXIS, Math.cos(phase)),
    scaleVec3(SOLAR_LATERAL_AXIS, Math.sin(phase)),
  ))
  return addVec3(
    addVec3(SUN_CENTER_WORLD, scaleVec3(orbitalDirection, distance)),
    scaleVec3(SOLAR_VERTICAL_AXIS, lift),
  )
}

const celestialBodies: CelestialBody[] = [
  {
    id: 'sun',
    name: 'SUN',
    kind: 'main-sequence star',
    bodyType: 'star',
    center: SUN_CENTER_WORLD,
    radius: SUN_RADIUS,
    physicalRadiusKm: 696_340,
    accent: { r: 0.96, g: 0.8, b: 0.32 },
    summary: 'Warm white photosphere with a tight golden corona. This is the directional light source for the whole scene.',
    briefData: [
      { label: 'rotation', value: '27 d' },
      { label: 'surface', value: '5,772 K' },
      { label: 'gravity', value: '274 m/s²' },
      { label: 'light lag', value: '8.3 min to Earth' },
    ],
    infoDistance: 180,
    minScreenRadius: 11,
  },
  {
    id: 'mercury',
    name: 'MERCURY',
    kind: 'rocky inner planet',
    bodyType: 'planet',
    center: placeSolarBody(120, 1.24, 0),
    radius: getPlanetDisplayRadiusFromEarths(0.383),
    physicalRadiusKm: 2_440,
    accent: { r: 0.74, g: 0.68, b: 0.62 },
    summary: 'Airless, cratered, and close to the sun. It reads as a hot gray-brown rock in this compressed layout.',
    briefData: [
      { label: 'year', value: '88 d' },
      { label: 'day', value: '58.6 d' },
      { label: 'gravity', value: '3.7 m/s²' },
      { label: 'tilt', value: '0.03°' },
    ],
    infoDistance: 78,
    minScreenRadius: 5.5,
    orbit: {
      ascendingNodeBase: 48.3313,
      ascendingNodeRate: 3.24587e-5,
      inclinationBase: 7.0047,
      inclinationRate: 5e-8,
      perihelionBase: 29.1241,
      perihelionRate: 1.01444e-5,
      semiMajorAxisBase: 0.387098,
      semiMajorAxisRate: 0,
      eccentricityBase: 0.205635,
      eccentricityRate: 5.59e-10,
      meanAnomalyBase: 168.6562,
      meanAnomalyRate: 4.0923344368,
    },
  },
  {
    id: 'venus',
    name: 'VENUS',
    kind: 'cloud-shrouded inner planet',
    bodyType: 'planet',
    center: placeSolarBody(188, 0.82, 0),
    radius: getPlanetDisplayRadiusFromEarths(0.949),
    physicalRadiusKm: 6_052,
    accent: { r: 0.9, g: 0.78, b: 0.48 },
    summary: 'Dense reflective cloud decks hide the surface and give it a warm cream-yellow glow.',
    briefData: [
      { label: 'year', value: '224.7 d' },
      { label: 'day', value: '243 d retro' },
      { label: 'gravity', value: '8.9 m/s²' },
      { label: 'tilt', value: '177.4°' },
    ],
    infoDistance: 104,
    minScreenRadius: 6.5,
    orbit: {
      ascendingNodeBase: 76.6799,
      ascendingNodeRate: 2.4659e-5,
      inclinationBase: 3.3946,
      inclinationRate: 2.75e-8,
      perihelionBase: 54.891,
      perihelionRate: 1.38374e-5,
      semiMajorAxisBase: 0.72333,
      semiMajorAxisRate: 0,
      eccentricityBase: 0.006773,
      eccentricityRate: -1.302e-9,
      meanAnomalyBase: 48.0052,
      meanAnomalyRate: 1.6021302244,
    },
  },
  {
    id: 'earth',
    name: 'EARTH',
    kind: 'temperate ocean world',
    bodyType: 'planet',
    center: placeSolarBody(EARTH_SUN_DISTANCE, 0, 0),
    radius: getPlanetDisplayRadiusFromEarths(1),
    physicalRadiusKm: 6_371,
    accent: { r: 0.34, g: 0.58, b: 0.92 },
    summary: 'Oceans, continents, ice caps, and a thin atmosphere that only really glows near the lit limb.',
    briefData: [
      { label: 'year', value: '365.3 d' },
      { label: 'day', value: '23.9 h' },
      { label: 'gravity', value: '9.8 m/s²' },
      { label: 'tilt', value: '23.4°' },
    ],
    infoDistance: 96,
    minScreenRadius: 7,
    orbit: {
      ascendingNodeBase: 0,
      ascendingNodeRate: 0,
      inclinationBase: 0,
      inclinationRate: 0,
      perihelionBase: 282.9404,
      perihelionRate: 4.70935e-5,
      semiMajorAxisBase: 1,
      semiMajorAxisRate: 0,
      eccentricityBase: 0.016709,
      eccentricityRate: -1.151e-9,
      meanAnomalyBase: 356.047,
      meanAnomalyRate: 0.9856002585,
    },
  },
  {
    id: 'mars',
    name: 'MARS',
    kind: 'dusty red planet',
    bodyType: 'planet',
    center: placeSolarBody(334, -0.56, 0),
    radius: getPlanetDisplayRadiusFromEarths(0.532),
    physicalRadiusKm: 3_390,
    accent: { r: 0.82, g: 0.42, b: 0.22 },
    summary: 'Iron-rich dust and exposed rock give it the dry red-orange tone of a cold desert world.',
    briefData: [
      { label: 'year', value: '687 d' },
      { label: 'day', value: '24.6 h' },
      { label: 'gravity', value: '3.7 m/s²' },
      { label: 'tilt', value: '25.2°' },
    ],
    infoDistance: 92,
    minScreenRadius: 5.5,
    orbit: {
      ascendingNodeBase: 49.5574,
      ascendingNodeRate: 2.11081e-5,
      inclinationBase: 1.8497,
      inclinationRate: -1.78e-8,
      perihelionBase: 286.5016,
      perihelionRate: 2.92961e-5,
      semiMajorAxisBase: 1.523688,
      semiMajorAxisRate: 0,
      eccentricityBase: 0.093405,
      eccentricityRate: 2.516e-9,
      meanAnomalyBase: 18.6021,
      meanAnomalyRate: 0.5240207766,
    },
  },
  {
    id: 'jupiter',
    name: 'JUPITER',
    kind: 'gas giant',
    bodyType: 'planet',
    center: placeSolarBody(510, 2.06, 0),
    radius: getPlanetDisplayRadiusFromEarths(11.21),
    physicalRadiusKm: 69_911,
    accent: { r: 0.84, g: 0.68, b: 0.5 },
    summary: 'Broad tan and rust bands wrap a huge gas giant with fast cloud structure and soft highlights.',
    briefData: [
      { label: 'year', value: '11.9 y' },
      { label: 'day', value: '9.9 h' },
      { label: 'gravity', value: '24.8 m/s²' },
      { label: 'tilt', value: '3.1°' },
    ],
    infoDistance: 190,
    minScreenRadius: 8.5,
    orbit: {
      ascendingNodeBase: 100.4542,
      ascendingNodeRate: 2.76854e-5,
      inclinationBase: 1.303,
      inclinationRate: -1.557e-7,
      perihelionBase: 273.8777,
      perihelionRate: 1.64505e-5,
      semiMajorAxisBase: 5.20256,
      semiMajorAxisRate: 0,
      eccentricityBase: 0.048498,
      eccentricityRate: 4.469e-9,
      meanAnomalyBase: 19.895,
      meanAnomalyRate: 0.0830853001,
    },
  },
  {
    id: 'saturn',
    name: 'SATURN',
    kind: 'ringed gas giant',
    bodyType: 'planet',
    center: placeSolarBody(642, 2.64, 0),
    radius: getPlanetDisplayRadiusFromEarths(9.45),
    physicalRadiusKm: 58_232,
    accent: { r: 0.92, g: 0.8, b: 0.58 },
    summary: 'Pale cloud bands and warm gold tones make Saturn the soft outer giant of this compressed system.',
    briefData: [
      { label: 'year', value: '29.5 y' },
      { label: 'day', value: '10.7 h' },
      { label: 'gravity', value: '10.4 m/s²' },
      { label: 'tilt', value: '26.7°' },
    ],
    infoDistance: 210,
    minScreenRadius: 8.5,
    orbit: {
      ascendingNodeBase: 113.6634,
      ascendingNodeRate: 2.3898e-5,
      inclinationBase: 2.4886,
      inclinationRate: -1.081e-7,
      perihelionBase: 339.3939,
      perihelionRate: 2.97661e-5,
      semiMajorAxisBase: 9.55475,
      semiMajorAxisRate: 0,
      eccentricityBase: 0.055546,
      eccentricityRate: -9.499e-9,
      meanAnomalyBase: 316.967,
      meanAnomalyRate: 0.0334442282,
    },
  },
  {
    id: 'uranus',
    name: 'URANUS',
    kind: 'ice giant',
    bodyType: 'planet',
    center: placeSolarBody(792, -2.08, 0),
    radius: getPlanetDisplayRadiusFromEarths(4.01),
    physicalRadiusKm: 25_362,
    accent: { r: 0.58, g: 0.86, b: 0.88 },
    summary: 'Cold methane haze pushes Uranus toward a pale cyan with much subtler banding than the gas giants.',
    briefData: [
      { label: 'year', value: '84.0 y' },
      { label: 'day', value: '17.2 h retro' },
      { label: 'gravity', value: '8.7 m/s²' },
      { label: 'tilt', value: '97.8°' },
    ],
    infoDistance: 220,
    minScreenRadius: 7.5,
    orbit: {
      ascendingNodeBase: 74.0005,
      ascendingNodeRate: 1.3978e-5,
      inclinationBase: 0.7733,
      inclinationRate: 1.9e-8,
      perihelionBase: 96.6612,
      perihelionRate: 3.0565e-5,
      semiMajorAxisBase: 19.18171,
      semiMajorAxisRate: -1.55e-8,
      eccentricityBase: 0.047318,
      eccentricityRate: 7.45e-9,
      meanAnomalyBase: 142.5905,
      meanAnomalyRate: 0.011725806,
    },
  },
  {
    id: 'neptune',
    name: 'NEPTUNE',
    kind: 'deep blue ice giant',
    bodyType: 'planet',
    center: placeSolarBody(940, -2.74, 0),
    radius: getPlanetDisplayRadiusFromEarths(3.88),
    physicalRadiusKm: 24_622,
    accent: { r: 0.34, g: 0.56, b: 0.92 },
    summary: 'A darker methane-blue outer world with stronger storm contrast and colder highlights than Uranus.',
    briefData: [
      { label: 'year', value: '164.8 y' },
      { label: 'day', value: '16.1 h' },
      { label: 'gravity', value: '11.2 m/s²' },
      { label: 'tilt', value: '28.3°' },
    ],
    infoDistance: 230,
    minScreenRadius: 7.5,
    orbit: {
      ascendingNodeBase: 131.7806,
      ascendingNodeRate: 3.0173e-5,
      inclinationBase: 1.77,
      inclinationRate: -2.55e-7,
      perihelionBase: 272.8461,
      perihelionRate: -6.027e-6,
      semiMajorAxisBase: 30.05826,
      semiMajorAxisRate: 3.313e-8,
      eccentricityBase: 0.008606,
      eccentricityRate: 2.15e-9,
      meanAnomalyBase: 260.2471,
      meanAnomalyRate: 0.005995147,
    },
  },
  {
    id: 'moon',
    name: 'MOON',
    kind: 'tidally locked rocky moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: 18, y: 0, z: -10 }),
    radius: getPlanetDisplayRadiusFromEarths(1_737.4 / 6_371),
    physicalRadiusKm: 1_737.4,
    accent: { r: 0.84, g: 0.84, b: 0.82 },
    summary: 'Earth’s synchronous companion, cratered and gray with strong terminator contrast.',
    briefData: [
      { label: 'primary', value: 'Earth' },
      { label: 'orbit', value: '27.3 d' },
      { label: 'distance', value: '384,400 km' },
      { label: 'gravity', value: '1.6 m/s²' },
    ],
    infoDistance: 58,
    minScreenRadius: 3.4,
    moonOrbit: {
      parentId: 'earth',
      semiMajorAxisKm: 384_400,
      orbitalPeriodDays: 27.321661,
      inclinationDegrees: 5.1,
      nodeDegrees: 112,
      phaseDegrees: 34,
    },
  },
  {
    id: 'io',
    name: 'IO',
    kind: 'volcanic moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: -24, y: 0, z: 0 }),
    radius: getPlanetDisplayRadiusFromEarths(1_821.6 / 6_371),
    physicalRadiusKm: 1_821.6,
    accent: { r: 0.98, g: 0.84, b: 0.32 },
    summary: 'Sulfur-yellow and heavily volcanic, with warm dark mottling across its face.',
    briefData: [
      { label: 'primary', value: 'Jupiter' },
      { label: 'orbit', value: '1.77 d' },
      { label: 'distance', value: '421,700 km' },
      { label: 'gravity', value: '1.8 m/s²' },
    ],
    infoDistance: 82,
    minScreenRadius: 3.4,
    moonOrbit: {
      parentId: 'jupiter',
      semiMajorAxisKm: 421_700,
      orbitalPeriodDays: 1.769138,
      inclinationDegrees: 0.05,
      nodeDegrees: 18,
      phaseDegrees: 212,
    },
  },
  {
    id: 'europa',
    name: 'EUROPA',
    kind: 'icy ocean moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: -28, y: 0, z: 0 }),
    radius: getPlanetDisplayRadiusFromEarths(1_560.8 / 6_371),
    physicalRadiusKm: 1_560.8,
    accent: { r: 0.9, g: 0.86, b: 0.76 },
    summary: 'Bright fractured ice with faint rust-toned lineation over a hidden ocean world.',
    briefData: [
      { label: 'primary', value: 'Jupiter' },
      { label: 'orbit', value: '3.55 d' },
      { label: 'distance', value: '671,100 km' },
      { label: 'gravity', value: '1.3 m/s²' },
    ],
    infoDistance: 88,
    minScreenRadius: 3.2,
    moonOrbit: {
      parentId: 'jupiter',
      semiMajorAxisKm: 671_100,
      orbitalPeriodDays: 3.551181,
      inclinationDegrees: 0.47,
      nodeDegrees: 46,
      phaseDegrees: 58,
    },
  },
  {
    id: 'ganymede',
    name: 'GANYMEDE',
    kind: 'large icy moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: -32, y: 0, z: 0 }),
    radius: getPlanetDisplayRadiusFromEarths(2_634.1 / 6_371),
    physicalRadiusKm: 2_634.1,
    accent: { r: 0.72, g: 0.74, b: 0.72 },
    summary: 'The largest moon in the scene, mixing darker rock with brighter ice provinces.',
    briefData: [
      { label: 'primary', value: 'Jupiter' },
      { label: 'orbit', value: '7.15 d' },
      { label: 'distance', value: '1,070,400 km' },
      { label: 'gravity', value: '1.4 m/s²' },
    ],
    infoDistance: 96,
    minScreenRadius: 3.8,
    moonOrbit: {
      parentId: 'jupiter',
      semiMajorAxisKm: 1_070_400,
      orbitalPeriodDays: 7.154553,
      inclinationDegrees: 0.2,
      nodeDegrees: 88,
      phaseDegrees: 132,
    },
  },
  {
    id: 'callisto',
    name: 'CALLISTO',
    kind: 'ancient cratered moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: -36, y: 0, z: 0 }),
    radius: getPlanetDisplayRadiusFromEarths(2_410.3 / 6_371),
    physicalRadiusKm: 2_410.3,
    accent: { r: 0.54, g: 0.5, b: 0.46 },
    summary: 'Dark, battered ice-rock terrain with one of the oldest surfaces in the system.',
    briefData: [
      { label: 'primary', value: 'Jupiter' },
      { label: 'orbit', value: '16.69 d' },
      { label: 'distance', value: '1,882,700 km' },
      { label: 'gravity', value: '1.2 m/s²' },
    ],
    infoDistance: 110,
    minScreenRadius: 3.6,
    moonOrbit: {
      parentId: 'jupiter',
      semiMajorAxisKm: 1_882_700,
      orbitalPeriodDays: 16.689018,
      inclinationDegrees: 0.19,
      nodeDegrees: 126,
      phaseDegrees: 276,
    },
  },
  {
    id: 'titan',
    name: 'TITAN',
    kind: 'hazy methane moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: 40, y: 0, z: 0 }),
    radius: getPlanetDisplayRadiusFromEarths(2_574.7 / 6_371),
    physicalRadiusKm: 2_574.7,
    accent: { r: 0.88, g: 0.68, b: 0.34 },
    summary: 'Orange atmospheric haze hides Titan’s surface and gives it a soft amber disk.',
    briefData: [
      { label: 'primary', value: 'Saturn' },
      { label: 'orbit', value: '15.95 d' },
      { label: 'distance', value: '1,221,900 km' },
      { label: 'gravity', value: '1.4 m/s²' },
    ],
    infoDistance: 118,
    minScreenRadius: 3.8,
    moonOrbit: {
      parentId: 'saturn',
      semiMajorAxisKm: 1_221_900,
      orbitalPeriodDays: 15.945421,
      inclinationDegrees: 0.33,
      nodeDegrees: 34,
      phaseDegrees: 148,
    },
  },
  {
    id: 'triton',
    name: 'TRITON',
    kind: 'retrograde icy moon',
    bodyType: 'moon',
    center: addVec3(PLANET_CENTER_WORLD, { x: 46, y: 0, z: 0 }),
    radius: getPlanetDisplayRadiusFromEarths(1_353.4 / 6_371),
    physicalRadiusKm: 1_353.4,
    accent: { r: 0.86, g: 0.82, b: 0.9 },
    summary: 'A bright, cold captured moon orbiting Neptune backwards through its sky.',
    briefData: [
      { label: 'primary', value: 'Neptune' },
      { label: 'orbit', value: '5.88 d' },
      { label: 'distance', value: '354,800 km' },
      { label: 'gravity', value: '0.8 m/s²' },
    ],
    infoDistance: 74,
    minScreenRadius: 3,
    moonOrbit: {
      parentId: 'neptune',
      semiMajorAxisKm: 354_800,
      orbitalPeriodDays: 5.876854,
      inclinationDegrees: 23,
      nodeDegrees: 72,
      phaseDegrees: 214,
      retrograde: true,
    },
  },
]

const sunBody = celestialBodies.find(body => body.id === 'sun')!
const earthBody = celestialBodies.find(body => body.id === 'earth')!
const saturnBody = celestialBodies.find(body => body.id === 'saturn')!
const planetBodies = celestialBodies.filter(body => body.bodyType === 'planet')
const moonBodies = celestialBodies.filter(body => body.bodyType === 'moon')
const renderableBodies = celestialBodies.filter(body => body.bodyType !== 'star')

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

function sinDegrees(degrees: number): number {
  return Math.sin(toRadians(degrees))
}

function cosDegrees(degrees: number): number {
  return Math.cos(toRadians(degrees))
}

function getTimeWarpOption(): (typeof TIME_WARP_OPTIONS)[number] {
  return TIME_WARP_OPTIONS[DEFAULT_TIME_WARP_INDEX]!
}

function getDaysSinceJ2000(timeMs: number): number {
  return (timeMs - J2000_UTC_MS) / JULIAN_DAY_MS
}

function getJulianCenturiesSinceJ2000(timeMs: number): number {
  return getDaysSinceJ2000(timeMs) / 36_525
}

function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number): number {
  let estimate = meanAnomaly + eccentricity * Math.sin(meanAnomaly) * (1 + eccentricity * Math.cos(meanAnomaly))
  for (let index = 0; index < 6; index++) {
    const delta = (estimate - eccentricity * Math.sin(estimate) - meanAnomaly) / (1 - eccentricity * Math.cos(estimate))
    estimate -= delta
    if (Math.abs(delta) < 1e-8) break
  }
  return estimate
}

function getHeliocentricEclipticPosition(orbit: OrbitalElements, timeMs: number): Vec3 {
  const days = getDaysSinceJ2000(timeMs)
  const ascendingNode = toRadians(normalizeDegrees(orbit.ascendingNodeBase + orbit.ascendingNodeRate * days))
  const inclination = toRadians(orbit.inclinationBase + orbit.inclinationRate * days)
  const perihelion = toRadians(normalizeDegrees(orbit.perihelionBase + orbit.perihelionRate * days))
  const semiMajorAxis = orbit.semiMajorAxisBase + orbit.semiMajorAxisRate * days
  const eccentricity = orbit.eccentricityBase + orbit.eccentricityRate * days
  const meanAnomaly = toRadians(normalizeDegrees(orbit.meanAnomalyBase + orbit.meanAnomalyRate * days))
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, eccentricity)
  const xv = semiMajorAxis * (Math.cos(eccentricAnomaly) - eccentricity)
  const yv = semiMajorAxis * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly)
  const trueAnomaly = Math.atan2(yv, xv)
  const radius = Math.hypot(xv, yv)
  const argument = trueAnomaly + perihelion

  return {
    x: radius * (Math.cos(ascendingNode) * Math.cos(argument) - Math.sin(ascendingNode) * Math.sin(argument) * Math.cos(inclination)),
    y: radius * (Math.sin(ascendingNode) * Math.cos(argument) + Math.cos(ascendingNode) * Math.sin(argument) * Math.cos(inclination)),
    z: radius * Math.sin(argument) * Math.sin(inclination),
  }
}

function getCompressedOrbitDistance(auDistance: number): number {
  return EARTH_SUN_DISTANCE * ORBIT_DISTANCE_SCALE * Math.pow(Math.max(0, auDistance), ORBIT_DISTANCE_EXPONENT)
}

function getOrbitReferenceAngle(timeMs: number): number {
  const earthOrbit = earthBody.orbit
  if (earthOrbit === undefined) return 0
  const earthHelio = getHeliocentricEclipticPosition(earthOrbit, timeMs)
  return Math.atan2(earthHelio.y, earthHelio.x)
}

function updateCelestialBodies(timeMs: number): void {
  const cosReference = Math.cos(state.orbitReferenceAngle)
  const sinReference = Math.sin(state.orbitReferenceAngle)

  for (let index = 0; index < planetBodies.length; index++) {
    const body = planetBodies[index]!
    if (body.orbit === undefined) continue

    const helio = getHeliocentricEclipticPosition(body.orbit, timeMs)
    const rotated = {
      x: helio.x * cosReference + helio.y * sinReference,
      y: -helio.x * sinReference + helio.y * cosReference,
      z: helio.z,
    }
    const radiusAu = lengthVec3(rotated)
    const compressedRadius = getCompressedOrbitDistance(radiusAu)
    const direction = normalizeVec3(rotated)

    body.center = addVec3(
      addVec3(
        addVec3(
          sunBody.center,
          scaleVec3(SOLAR_PRIMARY_AXIS, direction.x * compressedRadius),
        ),
        scaleVec3(SOLAR_LATERAL_AXIS, direction.y * compressedRadius),
      ),
      scaleVec3(SOLAR_VERTICAL_AXIS, direction.z * compressedRadius),
    )
  }
}

function formatKilometers(value: number): string {
  return `${INTEGER_FORMATTER.format(Math.round(value))} km`
}

function formatAstronomicalUnits(value: number): string {
  const digits = value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} AU`
}

function getHeliocentricDistanceAu(body: CelestialBody, timeMs: number): number | null {
  if (body.orbit !== undefined) return lengthVec3(getHeliocentricEclipticPosition(body.orbit, timeMs))
  if (body.moonOrbit !== undefined) {
    const parent = findBodyById(body.moonOrbit.parentId)
    if (parent !== null) return getHeliocentricDistanceAu(parent, timeMs)
  }
  return null
}

function getSolarIrradianceScale(body: CelestialBody, timeMs: number): number {
  if (body.id === 'sun') return 1
  const heliocentricDistanceAu = getHeliocentricDistanceAu(body, timeMs)
  if (heliocentricDistanceAu === null) return 1
  return 1 / Math.max(1e-4, heliocentricDistanceAu * heliocentricDistanceAu)
}

function getVisualSolarLightScale(body: CelestialBody, timeMs: number): number {
  const irradiance = getSolarIrradianceScale(body, timeMs)
  return 0.62 + 0.38 * Math.pow(clamp01(irradiance), SOLAR_VISUAL_FALLOFF_EXPONENT)
}

function equatorialToEcliptic(vec: Vec3): Vec3 {
  const epsilon = 23.4392911
  const cosEpsilon = cosDegrees(epsilon)
  const sinEpsilon = sinDegrees(epsilon)
  return {
    x: vec.x,
    y: vec.y * cosEpsilon + vec.z * sinEpsilon,
    z: -vec.y * sinEpsilon + vec.z * cosEpsilon,
  }
}

function eclipticToWorld(vec: Vec3): Vec3 {
  return normalizeVec3(addVec3(
    addVec3(
      scaleVec3(SOLAR_PRIMARY_AXIS, vec.x),
      scaleVec3(SOLAR_LATERAL_AXIS, vec.y),
    ),
    scaleVec3(SOLAR_VERTICAL_AXIS, vec.z),
  ))
}

function getEarthPrimeMeridianDegrees(timeMs: number): number {
  const days = getDaysSinceJ2000(timeMs)
  const centuries = getJulianCenturiesSinceJ2000(timeMs)
  return normalizeDegrees(
    190.147 + 360.9856235 * days + 0.000387933 * centuries * centuries - (centuries * centuries * centuries) / 38_710_000,
  )
}

function getBodyOrientationAngles(body: CelestialBody, timeMs: number): { rightAscensionDegrees: number, declinationDegrees: number, primeMeridianDegrees: number } {
  const days = getDaysSinceJ2000(timeMs)
  const centuries = getJulianCenturiesSinceJ2000(timeMs)

  switch (body.id) {
    case 'mercury': {
      const M1 = 174.7910857 + 4.092335 * days
      const M2 = 349.5821714 + 8.18467 * days
      const M3 = 164.3732571 + 12.277005 * days
      const M4 = 339.1643429 + 16.36934 * days
      const M5 = 153.9554286 + 20.461675 * days
      return {
        rightAscensionDegrees: 281.0103 - 0.0328 * centuries,
        declinationDegrees: 61.4155 - 0.0049 * centuries,
        primeMeridianDegrees: normalizeDegrees(
          329.5988 +
          6.1385108 * days +
          0.01067257 * sinDegrees(M1) -
          0.00112309 * sinDegrees(M2) -
          0.0001104 * sinDegrees(M3) -
          0.00002539 * sinDegrees(M4) -
          0.00000571 * sinDegrees(M5)
        ),
      }
    }
    case 'venus':
      return {
        rightAscensionDegrees: 272.76,
        declinationDegrees: 67.16,
        primeMeridianDegrees: normalizeDegrees(160.2 - 1.4813688 * days),
      }
    case 'earth':
      return {
        rightAscensionDegrees: normalizeDegrees(-0.641 * centuries),
        declinationDegrees: 90 - 0.557 * centuries,
        primeMeridianDegrees: getEarthPrimeMeridianDegrees(timeMs),
      }
    case 'mars': {
      const M1 = 198.991226 + 19139.4819985 * centuries
      const M2 = 226.292679 + 38280.8511281 * centuries
      const M3 = 249.663391 + 57420.7251593 * centuries
      const M4 = 266.18351 + 76560.636795 * centuries
      const M5 = 79.398797 + 0.5042615 * centuries
      return {
        rightAscensionDegrees:
          317.269202 -
          0.10927547 * centuries +
          0.000068 * sinDegrees(M1) +
          0.000238 * sinDegrees(M2) +
          0.000052 * sinDegrees(M3) +
          0.000009 * sinDegrees(M4) +
          0.419057 * sinDegrees(M5),
        declinationDegrees:
          54.432516 -
          0.05827105 * centuries +
          0.000051 * cosDegrees(M1) +
          0.000141 * cosDegrees(M2) +
          0.000031 * cosDegrees(M3) +
          0.000005 * cosDegrees(M4) +
          1.591274 * cosDegrees(M5),
        primeMeridianDegrees:
          normalizeDegrees(176.049863 + 350.891982443297 * days + 0.584542 * sinDegrees(M5)),
      }
    }
    case 'jupiter': {
      const Ja = 99.360714 + 4850.4046 * centuries
      const Jb = 175.895369 + 1191.9605 * centuries
      const Jc = 300.323162 + 262.5475 * centuries
      const Jd = 114.012305 + 6070.2476 * centuries
      const Je = 49.511251 + 64.3 * centuries
      return {
        rightAscensionDegrees:
          268.056595 -
          0.006499 * centuries +
          0.000117 * sinDegrees(Ja) +
          0.000938 * sinDegrees(Jb) +
          0.001432 * sinDegrees(Jc) +
          0.00003 * sinDegrees(Jd) +
          0.00215 * sinDegrees(Je),
        declinationDegrees:
          64.495303 +
          0.002413 * centuries +
          0.00005 * cosDegrees(Ja) +
          0.000404 * cosDegrees(Jb) +
          0.000617 * cosDegrees(Jc) -
          0.000013 * cosDegrees(Jd) +
          0.000926 * cosDegrees(Je),
        primeMeridianDegrees: normalizeDegrees(284.95 + 870.536 * days),
      }
    }
    case 'saturn':
      return {
        rightAscensionDegrees: 40.589 - 0.036 * centuries,
        declinationDegrees: 83.537 - 0.004 * centuries,
        primeMeridianDegrees: normalizeDegrees(38.9 + 810.7939024 * days),
      }
    case 'uranus':
      return {
        rightAscensionDegrees: 257.311,
        declinationDegrees: -15.175,
        primeMeridianDegrees: normalizeDegrees(203.81 - 501.1600928 * days),
      }
    case 'neptune': {
      const N = 357.85 + 52.316 * centuries
      return {
        rightAscensionDegrees: 299.36 + 0.7 * sinDegrees(N),
        declinationDegrees: 43.46 - 0.51 * cosDegrees(N),
        primeMeridianDegrees: normalizeDegrees(249.978 + 541.1397757 * days - 0.48 * sinDegrees(N)),
      }
    }
    default:
      return {
        rightAscensionDegrees: 286.13,
        declinationDegrees: 63.87,
        primeMeridianDegrees: normalizeDegrees(84.176 + 14.1844 * days),
      }
  }
}

function getBodyOrientationFrame(body: CelestialBody, timeMs: number): BodyOrientationFrame {
  if (body.bodyType === 'moon' && body.moonOrbit !== undefined) {
    const orbit = body.moonOrbit
    const parent = findBodyById(orbit.parentId)
    if (parent !== null) {
      const parentFrame = getBodyOrientationFrame(parent, timeMs)
      const ascendingAxis = normalizeVec3(addVec3(
        scaleVec3(parentFrame.meridian, Math.cos(toRadians(orbit.nodeDegrees))),
        scaleVec3(parentFrame.east, Math.sin(toRadians(orbit.nodeDegrees))),
      ))
      let orbitNormal = rotateVec3AroundAxis(parentFrame.north, ascendingAxis, toRadians(orbit.inclinationDegrees))
      if (orbit.retrograde) orbitNormal = scaleVec3(orbitNormal, -1)
      const axisA = ascendingAxis
      const axisB = normalizeVec3(crossVec3(orbitNormal, axisA))
      const signedDays = getDaysSinceJ2000(timeMs) * (orbit.retrograde ? -1 : 1)
      const angleRadians = toRadians(orbit.phaseDegrees + (360 * signedDays) / orbit.orbitalPeriodDays)
      const toParent = normalizeVec3(scaleVec3(
        addVec3(scaleVec3(axisA, Math.cos(angleRadians)), scaleVec3(axisB, Math.sin(angleRadians))),
        -1,
      ))
      const east = normalizeVec3(crossVec3(orbitNormal, toParent))
      const meridian = normalizeVec3(crossVec3(east, orbitNormal))
      return {
        meridian,
        east,
        north: orbitNormal,
      }
    }
  }

  const angles = getBodyOrientationAngles(body, timeMs)
  const alphaRadians = toRadians(normalizeDegrees(angles.rightAscensionDegrees))
  const deltaRadians = toRadians(angles.declinationDegrees)
  const meridianRadians = toRadians(normalizeDegrees(angles.primeMeridianDegrees))

  const northEquatorial = {
    x: Math.cos(deltaRadians) * Math.cos(alphaRadians),
    y: Math.cos(deltaRadians) * Math.sin(alphaRadians),
    z: Math.sin(deltaRadians),
  }
  const nodeEquatorial = normalizeVec3({
    x: -Math.sin(alphaRadians),
    y: Math.cos(alphaRadians),
    z: 0,
  })
  const eastEquatorial = normalizeVec3(crossVec3(northEquatorial, nodeEquatorial))
  const meridianEquatorial = normalizeVec3(addVec3(
    scaleVec3(nodeEquatorial, Math.cos(meridianRadians)),
    scaleVec3(eastEquatorial, Math.sin(meridianRadians)),
  ))
  const eastOfMeridianEquatorial = normalizeVec3(crossVec3(northEquatorial, meridianEquatorial))

  return {
    meridian: eclipticToWorld(equatorialToEcliptic(meridianEquatorial)),
    east: eclipticToWorld(equatorialToEcliptic(eastOfMeridianEquatorial)),
    north: eclipticToWorld(equatorialToEcliptic(northEquatorial)),
  }
}

function worldNormalToBodyNormal(normalWorld: Vec3, frame: BodyOrientationFrame): Vec3 {
  return normalizeVec3({
    x: dotVec3(normalWorld, frame.meridian),
    y: dotVec3(normalWorld, frame.north),
    z: dotVec3(normalWorld, frame.east),
  })
}

function getMoonDisplayDistance(body: CelestialBody, parent: CelestialBody): number {
  const orbit = body.moonOrbit
  if (orbit === undefined) return parent.radius * 4
  const orbitInParentRadii = orbit.semiMajorAxisKm / Math.max(1, parent.physicalRadiusKm)
  return parent.radius * 1.15 * Math.pow(Math.max(1, orbitInParentRadii), 0.5)
}

function updateMoonBodies(timeMs: number): void {
  for (let index = 0; index < moonBodies.length; index++) {
    const body = moonBodies[index]!
    const orbit = body.moonOrbit
    if (orbit === undefined) continue

    const parent = findBodyById(orbit.parentId)
    if (parent === null) continue

    const parentFrame = getBodyOrientationFrame(parent, timeMs)
    const ascendingAxis = normalizeVec3(addVec3(
      scaleVec3(parentFrame.meridian, Math.cos(toRadians(orbit.nodeDegrees))),
      scaleVec3(parentFrame.east, Math.sin(toRadians(orbit.nodeDegrees))),
    ))
    let orbitNormal = rotateVec3AroundAxis(parentFrame.north, ascendingAxis, toRadians(orbit.inclinationDegrees))
    if (orbit.retrograde) orbitNormal = scaleVec3(orbitNormal, -1)
    const axisA = ascendingAxis
    const axisB = normalizeVec3(crossVec3(orbitNormal, axisA))
    const signedDays = getDaysSinceJ2000(timeMs) * (orbit.retrograde ? -1 : 1)
    const angleRadians = toRadians(orbit.phaseDegrees + (360 * signedDays) / orbit.orbitalPeriodDays)
    const distance = getMoonDisplayDistance(body, parent)

    body.center = addVec3(
      parent.center,
      addVec3(
        scaleVec3(axisA, Math.cos(angleRadians) * distance),
        scaleVec3(axisB, Math.sin(angleRadians) * distance),
      ),
    )
  }
}

function getOrbitDisplayRadius(body: CelestialBody): number {
  if (body.moonOrbit !== undefined) {
    const parent = findBodyById(body.moonOrbit.parentId)
    if (parent !== null) return distanceVec3(parent.center, sunBody.center)
  }
  if (body.orbit === undefined) return distanceVec3(body.center, sunBody.center)
  return getCompressedOrbitDistance(body.orbit.semiMajorAxisBase)
}

function updateSimulation(dt: number): void {
  const timeWarp = getTimeWarpOption()
  state.simulationTimeMs += dt * JULIAN_DAY_MS * timeWarp.daysPerSecond
  updateCelestialBodies(state.simulationTimeMs)
  updateMoonBodies(state.simulationTimeMs)
}

function syncSaturnRingParticles(): void {
  if (saturnRingParticles.length !== 0) return

  for (let index = 0; index < SATURN_RING_PARTICLE_COUNT; index++) {
    const t = Math.random()
    const midBias = 1 - Math.pow(Math.abs(t * 2 - 1), 1.8)
    saturnRingParticles.push({
      angle: Math.random() * Math.PI * 2,
      radiusFactor: lerp(SATURN_RING_INNER_FACTOR, SATURN_RING_OUTER_FACTOR, midBias),
      heightFactor: randomRange(-SATURN_RING_THICKNESS_FACTOR, SATURN_RING_THICKNESS_FACTOR),
      size: randomRange(0.16, 0.62),
      brightness: randomRange(0.18, 0.76) * (0.58 + midBias * 0.42),
    })
  }
}

function luminance(color: Rgb): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
}

function multiplyColor(color: Rgb, scalar: number): Rgb {
  return { r: color.r * scalar, g: color.g * scalar, b: color.b * scalar }
}

function addColor(a: Rgb, b: Rgb): Rgb {
  return { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b }
}

function mixColor(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  }
}

function clampColor(color: Rgb): Rgb {
  return {
    r: clamp01(color.r),
    g: clamp01(color.g),
    b: clamp01(color.b),
  }
}

function toneMapColor(color: Rgb, exposure = SCENE_EXPOSURE): Rgb {
  return {
    r: 1 - Math.exp(-Math.max(0, color.r) * exposure),
    g: 1 - Math.exp(-Math.max(0, color.g) * exposure),
    b: 1 - Math.exp(-Math.max(0, color.b) * exposure),
  }
}

function quantizeColorComponent(value: number): number {
  const quantized = Math.round(clamp01(value) * 15) * 17
  return clamp(quantized, 0, 255)
}

function getQuantizedColorIndex(color: Rgb): number {
  const r = Math.round(clamp01(color.r) * 15)
  const g = Math.round(clamp01(color.g) * 15)
  const b = Math.round(clamp01(color.b) * 15)
  return (r << 8) | (g << 4) | b
}

function toCssColor(color: Rgb): string {
  const cacheIndex = getQuantizedColorIndex(color)
  const cached = quantizedColorCache[cacheIndex]
  if (cached !== undefined) return cached

  const r = ((cacheIndex >> 8) & 0x0f) * 17
  const g = ((cacheIndex >> 4) & 0x0f) * 17
  const b = (cacheIndex & 0x0f) * 17
  const css = `rgb(${r} ${g} ${b})`
  quantizedColorCache[cacheIndex] = css
  return css
}

function toCssColorAlpha(color: Rgb, alpha: number): string {
  const r = quantizeColorComponent(color.r)
  const g = quantizeColorComponent(color.g)
  const b = quantizeColorComponent(color.b)
  return `rgb(${r} ${g} ${b} / ${clamp01(alpha)})`
}

function getSpeed(): number {
  return LOCKED_THRUST_MULTIPLIER
}

function getTargetStarCount(): number {
  return LOCKED_STAR_COUNT
}

function getFont(fontSize: number): string {
  return `${FONT_WEIGHT} ${fontSize}px ${FONT_FAMILY}`
}

function getSingleLineWidth(text: string, font: string): number {
  const prepared = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' })
  let width = 0
  walkLineRanges(prepared, 1e9, line => {
    width = line.width
  })
  return width
}

function getCellWidth(font: string): number {
  const cached = rowWidthCache.get(font)
  if (cached !== undefined) return cached

  const width = getSingleLineWidth(TEMPLATE_ROW, font) / SAMPLE_COLUMNS
  rowWidthCache.set(font, width)
  return width
}

function createProjection(cols: number, rows: number, blockWidth: number, blockHeight: number): Projection {
  const aspect = blockWidth / Math.max(1, blockHeight)
  const halfHorizontal = (HORIZONTAL_FOV_DEGREES * Math.PI) / 360
  const tanHalfHorizontal = Math.tan(halfHorizontal)
  const tanHalfVertical = tanHalfHorizontal / Math.max(0.1, aspect)

  return {
    focalX: (cols * 0.5) / tanHalfHorizontal,
    focalY: (rows * 0.5) / tanHalfVertical,
  }
}

function measureGridCandidate(fontSize: number, availableWidth: number, availableHeight: number): GridCandidate {
  const font = getFont(fontSize)
  const cellWidth = getCellWidth(font)
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO)
  const cols = Math.max(1, Math.floor(availableWidth / cellWidth))
  const rows = Math.max(1, Math.floor(availableHeight / lineHeight))

  return {
    font,
    fontSize,
    lineHeight,
    cellWidth,
    cols,
    rows,
    blockWidth: cols * cellWidth,
    blockHeight: rows * lineHeight,
  }
}

function fitMetrics(width: number, height: number): Metrics {
  const availableWidth = Math.max(1, width - H_PADDING * 2)
  const availableHeight = Math.max(1, height - V_PADDING * 2)

  let best = measureGridCandidate(FONT_SIZE_MAX, availableWidth, availableHeight)
  for (let fontSize = FONT_SIZE_MIN; fontSize <= FONT_SIZE_MAX; fontSize++) {
    const candidate = measureGridCandidate(fontSize, availableWidth, availableHeight)
    best = candidate
    if (
      candidate.cols >= MIN_COLS &&
      candidate.rows >= MIN_ROWS &&
      candidate.cols * candidate.rows <= MAX_CELL_COUNT
    ) {
      break
    }
  }

  return {
    ...best,
    left: Math.round((width - best.blockWidth) / 2),
    top: Math.round((height - best.blockHeight) / 2),
    baselineOffset: Math.round(best.fontSize * 0.82),
    projection: createProjection(best.cols, best.rows, best.blockWidth, best.blockHeight),
  }
}

function estimateBrightness(ch: string, font: string, fontSize: number): number {
  const sampleSize = Math.max(48, Math.min(120, Math.round(fontSize * 3)))
  brightnessCanvas.width = sampleSize
  brightnessCanvas.height = sampleSize

  bCtx.clearRect(0, 0, sampleSize, sampleSize)
  bCtx.font = font
  bCtx.fillStyle = '#fff'
  bCtx.textAlign = 'center'
  bCtx.textBaseline = 'middle'
  bCtx.fillText(ch, sampleSize * 0.5, sampleSize * 0.5)

  const data = bCtx.getImageData(0, 0, sampleSize, sampleSize).data
  let alphaSum = 0
  for (let index = 3; index < data.length; index += 4) {
    alphaSum += data[index]!
  }
  return alphaSum / (255 * sampleSize * sampleSize)
}

function findBestGlyph(entries: GlyphEntry[], targetBrightness: number, targetWidth: number): GlyphEntry {
  let lo = 0
  let hi = entries.length - 1

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid]!.brightness < targetBrightness) lo = mid + 1
    else hi = mid
  }

  let best = entries[lo]!
  let bestScore = Number.POSITIVE_INFINITY
  const start = Math.max(0, lo - 12)
  const end = Math.min(entries.length, lo + 13)

  for (let index = start; index < end; index++) {
    const entry = entries[index]!
    const brightnessError = Math.abs(entry.brightness - targetBrightness) * 4
    const widthError = Math.abs(entry.width - targetWidth) / Math.max(1, targetWidth)
    const score = brightnessError + widthError * 0.35
    if (score < bestScore) {
      bestScore = score
      best = entry
    }
  }

  return best
}

function buildGlyphPalette(font: string, fontSize: number, targetWidth: number): GlyphPalette {
  const entries: GlyphEntry[] = []

  for (let index = 0; index < CLASSIC_ASCII_CANDIDATES.length; index++) {
    const char = CLASSIC_ASCII_CANDIDATES[index]!
    const width = getSingleLineWidth(char, font)
    const brightness = char === ' ' ? 0 : estimateBrightness(char, font, fontSize)
    entries.push({ char, width, brightness })
  }

  const maxBrightness = Math.max(1e-6, ...entries.map(entry => entry.brightness))
  for (let index = 0; index < entries.length; index++) {
    entries[index]!.brightness /= maxBrightness
  }
  entries.sort((a, b) => a.brightness - b.brightness)

  const lookup = Array.from<string>({ length: 256 })
  for (let brightnessByte = 0; brightnessByte < 256; brightnessByte++) {
    const targetBrightness = brightnessByte / 255
    lookup[brightnessByte] = findBestGlyph(entries, targetBrightness, targetWidth).char
  }

  return { entries, lookup }
}

function getGlyphPalette(metrics: Metrics): GlyphPalette {
  const cached = paletteCache.get(metrics.font)
  if (cached !== undefined) return cached

  const palette = buildGlyphPalette(metrics.font, metrics.fontSize, metrics.cellWidth)
  paletteCache.set(metrics.font, palette)
  return palette
}

function ensureBuffers(length: number): void {
  if (state.redField.length === length) return
  state.redField = new Float32Array(length)
  state.greenField = new Float32Array(length)
  state.blueField = new Float32Array(length)
  state.depthField = new Float32Array(length)
}

function getCanvasCssWidth(): number {
  return Math.max(1, mainCanvas?.width ?? 0) / Math.max(1, state.viewport.dpr)
}

function getCanvasCssHeight(): number {
  return Math.max(1, mainCanvas?.height ?? 0) / Math.max(1, state.viewport.dpr)
}

function syncCanvasMetrics(): void {
  if (mainCanvas === null) return

  const cssWidth = Math.max(1, Math.round(state.viewport.width))
  const cssHeight = Math.max(1, Math.round(state.viewport.height))
  const dpr = Math.max(1, state.viewport.dpr)
  const pixelWidth = Math.round(cssWidth * dpr)
  const pixelHeight = Math.round(cssHeight * dpr)

  if (mainCanvas.width !== pixelWidth || mainCanvas.height !== pixelHeight) {
    mainCanvas.width = pixelWidth
    mainCanvas.height = pixelHeight
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  state.metrics = fitMetrics(cssWidth, cssHeight)
  state.palette = getGlyphPalette(state.metrics)
  ensureBuffers(state.metrics.cols * state.metrics.rows)
  updateHud()
}

function updateHud(): void {
  const briefBody =
    state.briefOpenBodyId === null
      ? null
      : celestialBodies.find(body => body.id === state.briefOpenBodyId) ?? null

  workerScope.postMessage({
    type: 'snapshot',
    hud: {
      speed: getCurrentSpeed(),
      timeMs: state.simulationTimeMs,
      panels: state.hudPanels,
      brief: briefBody === null
        ? null
        : {
            id: briefBody.id,
            name: briefBody.name,
            kind: briefBody.kind,
            bodyType: briefBody.bodyType,
            summary: briefBody.summary,
            accent: briefBody.accent,
            briefData: briefBody.briefData,
          },
    },
  } satisfies WorkerOutboundMessage)
}

function createCameraTransform(camera: CameraState): CameraTransform {
  const cosPitch = Math.cos(camera.pitch)
  const forward = normalizeVec3({
    x: Math.sin(camera.yaw) * cosPitch,
    y: Math.sin(camera.pitch),
    z: Math.cos(camera.yaw) * cosPitch,
  })
  const right = normalizeVec3(crossVec3(WORLD_UP, forward))
  const up = normalizeVec3(crossVec3(forward, right))
  return { ...camera, forward, right, up }
}

function worldToCamera(point: Vec3, camera: CameraTransform): Vec3 {
  const relative = subtractVec3(point, camera.position)
  return {
    x: dotVec3(relative, camera.right),
    y: dotVec3(relative, camera.up),
    z: dotVec3(relative, camera.forward),
  }
}

function directionToCamera(direction: Vec3, camera: CameraTransform): Vec3 {
  return {
    x: dotVec3(direction, camera.right),
    y: dotVec3(direction, camera.up),
    z: dotVec3(direction, camera.forward),
  }
}

function stampDisk(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  depthZ: number,
  cols: number,
  rows: number,
  sample: (normalizedDistance: number) => Rgb | null,
): void {
  const minCol = Math.max(0, Math.floor(centerX - radiusX))
  const maxCol = Math.min(cols - 1, Math.ceil(centerX + radiusX))
  const minRow = Math.max(0, Math.floor(centerY - radiusY))
  const maxRow = Math.min(rows - 1, Math.ceil(centerY + radiusY))

  for (let row = minRow; row <= maxRow; row++) {
    const dy = ((row + 0.5) - centerY) / Math.max(1e-6, radiusY)
    for (let col = minCol; col <= maxCol; col++) {
      const dx = ((col + 0.5) - centerX) / Math.max(1e-6, radiusX)
      const normalizedDistance = Math.hypot(dx, dy)
      const color = sample(normalizedDistance)
      if (color === null) continue

      const index = row * cols + col
      if (depthZ >= state.depthField[index]!) continue
      state.redField[index] = color.r
      state.greenField[index] = color.g
      state.blueField[index] = color.b
      state.depthField[index] = depthZ
    }
  }
}

function addDiskGlow(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  depthZ: number,
  cols: number,
  rows: number,
  sample: (normalizedDistance: number) => Rgb | null,
): void {
  const minCol = Math.max(0, Math.floor(centerX - radiusX))
  const maxCol = Math.min(cols - 1, Math.ceil(centerX + radiusX))
  const minRow = Math.max(0, Math.floor(centerY - radiusY))
  const maxRow = Math.min(rows - 1, Math.ceil(centerY + radiusY))

  for (let row = minRow; row <= maxRow; row++) {
    const dy = ((row + 0.5) - centerY) / Math.max(1e-6, radiusY)
    for (let col = minCol; col <= maxCol; col++) {
      const dx = ((col + 0.5) - centerX) / Math.max(1e-6, radiusX)
      const normalizedDistance = Math.hypot(dx, dy)
      const color = sample(normalizedDistance)
      if (color === null) continue

      const index = row * cols + col
      if (depthZ >= state.depthField[index]!) continue
      addStarEnergy(index, color, 1)
    }
  }
}

function projectPoint(point: Vec3, projection: Projection, cols: number, rows: number): { x: number, y: number } {
  return {
    x: cols * 0.5 + (point.x / point.z) * projection.focalX,
    y: rows * 0.5 - (point.y / point.z) * projection.focalY,
  }
}

function createFloatingPanelAnchor(camera: CameraTransform, slot: number, kind: 'brief' | 'answer'): Vec3 {
  const forwardDistance = Math.max(16, FLOATING_PANEL_FORWARD - slot * 2)
  const lateral =
    kind === 'brief'
      ? FLOATING_PANEL_LATERAL
      : -10 - slot * 14
  const vertical =
    kind === 'brief'
      ? FLOATING_PANEL_VERTICAL
      : 8 - slot * 9

  return addVec3(
    addVec3(
      addVec3(camera.position, scaleVec3(camera.forward, forwardDistance)),
      scaleVec3(camera.right, lateral),
    ),
    scaleVec3(camera.up, vertical),
  )
}

function clearFloatingPanels(): void {
  state.floatingBriefPanel = null
  state.floatingAnswerPanels.length = 0
  state.hudPanels = []
}

function syncFloatingPanels(camera: CameraTransform): void {
  if (!state.flightStarted) {
    clearFloatingPanels()
    return
  }

  if (state.briefOpenBodyId === null) {
    state.floatingBriefPanel = null
    return
  }

  if (state.floatingBriefPanel === null || state.floatingBriefPanel.bodyId !== state.briefOpenBodyId) {
    state.floatingBriefPanel = {
      id: 0,
      kind: 'brief',
      bodyId: state.briefOpenBodyId,
      anchor: createFloatingPanelAnchor(camera, 0, 'brief'),
    }
  }
}

function projectFloatingPanels(camera: CameraTransform): HudWorldPanel[] {
  const metrics = state.metrics
  if (metrics === null) return []

  const panels = state.floatingBriefPanel === null
    ? state.floatingAnswerPanels
    : [state.floatingBriefPanel, ...state.floatingAnswerPanels]

  return panels.map(panel => {
    const cameraPoint = worldToCamera(panel.anchor, camera)
    if (cameraPoint.z <= NEAR_Z) {
      return {
        id: panel.id,
        kind: panel.kind,
        bodyId: panel.bodyId,
        screenX: 0,
        screenY: 0,
        scale: 1,
        visible: false,
      }
    }

    const projected = projectPoint(cameraPoint, metrics.projection, metrics.cols, metrics.rows)
    const screenX = metrics.left + projected.x * metrics.cellWidth
    const screenY = metrics.top + projected.y * metrics.lineHeight
    const width = getCanvasCssWidth()
    const height = getCanvasCssHeight()
    const visible = screenX >= -180 && screenX <= width + 180 && screenY >= -180 && screenY <= height + 180
    const scale = clamp(FLOATING_PANEL_SCALE_DISTANCE / cameraPoint.z, FLOATING_PANEL_MIN_SCALE, FLOATING_PANEL_MAX_SCALE)

    return {
      id: panel.id,
      kind: panel.kind,
      bodyId: panel.bodyId,
      screenX,
      screenY,
      scale,
      visible,
    }
  })
}

function drawFloatingPanelGuides(camera: CameraTransform): void {
  const metrics = state.metrics
  if (metrics === null) return

  const panels = state.hudPanels
  if (panels.length === 0) return

  ctx.save()
  ctx.lineWidth = 1

  for (let index = 0; index < panels.length; index++) {
    const panel = panels[index]!
    if (!panel.visible) continue

    const body = celestialBodies.find(candidate => candidate.id === panel.bodyId)
    if (body === undefined) continue

    const bodyCamera = worldToCamera(body.center, camera)
    if (bodyCamera.z <= NEAR_Z) continue
    const projectedBody = projectPoint(bodyCamera, metrics.projection, metrics.cols, metrics.rows)
    const bodyScreenX = metrics.left + projectedBody.x * metrics.cellWidth
    const bodyScreenY = metrics.top + projectedBody.y * metrics.lineHeight

    const alpha = panel.kind === 'brief' ? 0.58 : 0.34
    ctx.strokeStyle = toCssColorAlpha(body.accent, alpha)
    ctx.fillStyle = toCssColorAlpha(body.accent, alpha + 0.08)

    ctx.beginPath()
    ctx.moveTo(bodyScreenX, bodyScreenY)
    ctx.lineTo(panel.screenX, panel.screenY)
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(panel.screenX, panel.screenY, panel.kind === 'brief' ? 3.2 : 2.4, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function worldToMinimapPlane(point: Vec3): { x: number, y: number } {
  const relative = subtractVec3(point, sunBody.center)
  return {
    x: dotVec3(relative, SOLAR_LATERAL_AXIS),
    y: dotVec3(relative, SOLAR_PRIMARY_AXIS),
  }
}

function syncMinimapCanvas(): { width: number, height: number } {
  if (minimapCanvas === null) return { width: 1, height: 1 }

  const cssWidth = Math.max(1, Math.round(state.viewport.minimapWidth))
  const cssHeight = Math.max(1, Math.round(state.viewport.minimapHeight))
  const dpr = Math.max(1, state.viewport.dpr)
  const pixelWidth = Math.round(cssWidth * dpr)
  const pixelHeight = Math.round(cssHeight * dpr)

  if (minimapCanvas.width !== pixelWidth || minimapCanvas.height !== pixelHeight) {
    minimapCanvas.width = pixelWidth
    minimapCanvas.height = pixelHeight
  }

  miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { width: cssWidth, height: cssHeight }
}

function getWrappedInfoLines(text: string, maxWidth: number): string[] {
  const key = `${INFO_FONT}|${maxWidth}|${text}`
  const cached = infoLineCache.get(key)
  if (cached !== undefined) return cached

  const prepared = prepareWithSegments(text, INFO_FONT, { whiteSpace: 'pre-wrap' })
  const lines = layoutWithLines(prepared, maxWidth, INFO_LINE_HEIGHT).lines.map(line => line.text)
  infoLineCache.set(key, lines)
  return lines
}

function randomDirection(): Vec3 {
  const z = randomRange(-1, 1)
  const angle = randomRange(0, Math.PI * 2)
  const radial = Math.sqrt(1 - z * z)
  return {
    x: Math.cos(angle) * radial,
    y: z,
    z: Math.sin(angle) * radial,
  }
}

function createDistantStar(): DistantStar {
  const temp = fract(Math.random() * 9.91)
  const hueBias = fract(Math.random() * 5.17)
  const tint = mixColor(
    { r: 0.78, g: 0.8, b: 0.84 },
    mixColor({ r: 0.72, g: 0.78, b: 0.95 }, { r: 0.96, g: 0.9, b: 0.78 }, hueBias),
    temp * 0.28,
  )
  return {
    direction: randomDirection(),
    intensity: randomRange(0.22, 1),
    tint,
  }
}

function syncStarCount(): void {
  const target = getTargetStarCount()
  while (stars.length < target) stars.push(createDistantStar())
  while (stars.length > target) stars.pop()
}

function clearBuffers(): void {
  state.redField.fill(0)
  state.greenField.fill(0)
  state.blueField.fill(0)
  state.depthField.fill(Number.POSITIVE_INFINITY)
}

function addStarEnergy(index: number, color: Rgb, strength: number): void {
  state.redField[index] = clamp01(state.redField[index]! + color.r * strength)
  state.greenField[index] = clamp01(state.greenField[index]! + color.g * strength)
  state.blueField[index] = clamp01(state.blueField[index]! + color.b * strength)
}

function splatProjectedColor(
  x: number,
  y: number,
  color: Rgb,
  strength: number,
  depthZ: number,
  cols: number,
  rows: number,
): void {
  if (strength <= 0) return

  const left = Math.floor(x)
  const top = Math.floor(y)
  const tx = x - left
  const ty = y - top

  for (let dy = 0; dy <= 1; dy++) {
    const row = top + dy
    if (row < 0 || row >= rows) continue

    const wy = dy === 0 ? 1 - ty : ty
    for (let dx = 0; dx <= 1; dx++) {
      const col = left + dx
      if (col < 0 || col >= cols) continue

      const wx = dx === 0 ? 1 - tx : tx
      const index = row * cols + col
      if (depthZ >= state.depthField[index]!) continue
      addStarEnergy(index, color, strength * wx * wy)
    }
  }
}

function stampProjectedTrail(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: Rgb,
  strength: number,
  cols: number,
  rows: number,
): void {
  const dx = toX - fromX
  const dy = toY - fromY
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * TRAIL_GAIN))

  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    splatProjectedColor(
      fromX + dx * t,
      fromY + dy * t,
      color,
      strength * (0.14 + 0.76 * t),
      STAR_DEPTH,
      cols,
      rows,
    )
  }
}

function renderSun(metrics: Metrics, camera: CameraTransform): void {
  const sunCamera = worldToCamera(sunBody.center, camera)
  if (sunCamera.z <= NEAR_Z) return

  const projected = projectPoint(sunCamera, metrics.projection, metrics.cols, metrics.rows)
  const actualRadiusX = Math.abs((metrics.projection.focalX * SUN_RADIUS) / sunCamera.z)
  const actualRadiusY = Math.abs((metrics.projection.focalY * SUN_RADIUS) / sunCamera.z)
  const coreRadiusX = Math.max(1.7, actualRadiusX * SUN_CORE_SCALE)
  const coreRadiusY = Math.max(1.7, actualRadiusY * SUN_CORE_SCALE)
  const coronaRadiusX = coreRadiusX * SUN_CORONA_SCALE
  const coronaRadiusY = coreRadiusY * SUN_CORONA_SCALE
  const depthZ = Math.max(NEAR_Z, sunCamera.z - SUN_RADIUS)

  addDiskGlow(projected.x, projected.y, coronaRadiusX, coronaRadiusY, depthZ, metrics.cols, metrics.rows, normalizedDistance => {
    if (normalizedDistance > 1) return null
    const halo = Math.pow(clamp01(1 - normalizedDistance), 3.8)
    const intensity = halo * 0.17
    return {
      r: intensity * 0.95,
      g: intensity * 0.68,
      b: intensity * 0.2,
    }
  })

  stampDisk(projected.x, projected.y, coreRadiusX, coreRadiusY, depthZ, metrics.cols, metrics.rows, normalizedDistance => {
    if (normalizedDistance > 1) return null
    const disk = Math.pow(clamp01(1 - normalizedDistance), 0.4)
    const hotCore = Math.pow(clamp01(1 - normalizedDistance / 0.48), 2.4)
    return clampColor({
      r: disk * 0.92 + hotCore * 0.16,
      g: disk * 0.82 + hotCore * 0.14,
      b: disk * 0.48 + hotCore * 0.06,
    })
  })
}

function intersectSphere(origin: Vec3, direction: Vec3, center: Vec3, radius: number): number | null {
  const oc = subtractVec3(origin, center)
  const b = 2 * dotVec3(direction, oc)
  const c = dotVec3(oc, oc) - radius * radius
  const discriminant = b * b - 4 * c
  if (discriminant < 0) return null

  const root = Math.sqrt(discriminant)
  let t = (-b - root) * 0.5
  if (t <= 0) t = (-b + root) * 0.5
  if (t <= NEAR_Z) return null
  return t
}

function quantizeLongitudeFrequency(frequency: number): number {
  return Math.max(1, Math.round(Math.abs(frequency))) * Math.sign(frequency || 1)
}

function sinLonLat(longitude: number, latitude: number, longitudeFrequency: number, latitudeFrequency = 0, phase = 0): number {
  return Math.sin(
    longitude * quantizeLongitudeFrequency(longitudeFrequency) +
    latitude * latitudeFrequency +
    phase,
  )
}

function cosLonLat(longitude: number, latitude: number, longitudeFrequency: number, latitudeFrequency = 0, phase = 0): number {
  return Math.cos(
    longitude * quantizeLongitudeFrequency(longitudeFrequency) +
    latitude * latitudeFrequency +
    phase,
  )
}

function getPlanetSurfaceSample(body: CelestialBody, normalWorld: Vec3): {
  base: Rgb
  ambient: number
  diffuseStrength: number
  atmosphereColor: Rgb
  atmosphereStrength: number
  specularStrength: number
  gloss: number
  specularMask: number
} {
  const longitude = Math.atan2(normalWorld.z, normalWorld.x)
  const latitude = Math.asin(clamp(normalWorld.y, -1, 1))
  const equator = 1 - Math.abs(normalWorld.y)

  if (body.id === 'earth') {
    const continentField =
      gaussianLobe(longitude, latitude, -103, 49, 26, 16, 1.2) +
      gaussianLobe(longitude, latitude, -98, 28, 18, 10, 0.82) +
      gaussianLobe(longitude, latitude, -151, 61, 16, 10, 0.42) +
      gaussianLobe(longitude, latitude, -60, -15, 18, 26, 1.12) +
      gaussianLobe(longitude, latitude, -42, 73, 12, 8, 0.58) +
      gaussianLobe(longitude, latitude, -7, 15, 18, 20, 0.84) +
      gaussianLobe(longitude, latitude, 24, 5, 18, 22, 1.2) +
      gaussianLobe(longitude, latitude, 24, -23, 11, 14, 0.68) +
      gaussianLobe(longitude, latitude, 15, 51, 16, 11, 0.64) +
      gaussianLobe(longitude, latitude, 62, 51, 36, 16, 1.36) +
      gaussianLobe(longitude, latitude, 102, 56, 26, 14, 0.98) +
      gaussianLobe(longitude, latitude, 104, 24, 18, 13, 0.86) +
      gaussianLobe(longitude, latitude, 79, 21, 11, 9, 0.66) +
      gaussianLobe(longitude, latitude, 135, -25, 14, 10, 0.95) +
      gaussianLobe(longitude, latitude, 47, -19, 5, 5, 0.16) +
      gaussianLobe(longitude, latitude, 138, 37, 5, 4, 0.14)
    const continentalDetail =
      0.16 * sinLonLat(longitude, latitude, 7.8, -3.3) +
      0.11 * sinLonLat(longitude, latitude, 12.4, 12.4) +
      0.08 * Math.cos(normalWorld.x * 15.1 + normalWorld.z * 9.4) +
      0.06 * Math.sin(normalWorld.y * 19.6 - normalWorld.z * 11.3)
    const continental = continentField + continentalDetail
    const landMask = smoothstep(0.38, 0.62, continental)
    const coastMask = smoothstep(0.24, 0.58, continental)

    const oceanCurrent =
      0.5 + 0.5 * sinLonLat(longitude, latitude, 2.6, 5.2) * 0.55 +
      0.18 * sinLonLat(longitude, latitude, 7.4, -7.4)
    const shelfMix = clamp01(coastMask * 0.82 + oceanCurrent * 0.18)
    const oceanBase = mixColor(
      mixColor({ r: 0.01, g: 0.05, b: 0.14 }, { r: 0.02, g: 0.12, b: 0.26 }, equator * 0.55 + 0.2),
      { r: 0.05, g: 0.33, b: 0.52 },
      shelfMix,
    )

    const desertField =
      gaussianLobe(longitude, latitude, 13, 22, 18, 9, 1) +
      gaussianLobe(longitude, latitude, 48, 24, 12, 7, 0.74) +
      gaussianLobe(longitude, latitude, 72, 42, 18, 10, 0.52) +
      gaussianLobe(longitude, latitude, 133, -24, 14, 10, 0.58) +
      gaussianLobe(longitude, latitude, -112, 34, 10, 7, 0.32) +
      gaussianLobe(longitude, latitude, -70, -24, 8, 6, 0.26)
    const rainforestField =
      gaussianLobe(longitude, latitude, -60, -5, 18, 11, 1) +
      gaussianLobe(longitude, latitude, 21, 0, 12, 9, 0.74) +
      gaussianLobe(longitude, latitude, 104, 7, 18, 11, 0.8)
    const humidityNoise =
      0.5 +
      0.5 * (
        0.58 * sinLonLat(longitude, latitude, 4.6, -2.2) +
        0.28 * sinLonLat(longitude, latitude, 8.8, 8.8) +
        0.14 * Math.cos(normalWorld.x * 12.4 - normalWorld.z * 10.8)
      )
    const latitudeCold = smoothstep(0.44, 0.9, Math.abs(normalWorld.y))
    const borealMask = smoothstep(0.28, 0.62, Math.abs(normalWorld.y)) * (1 - smoothstep(0.68, 0.88, Math.abs(normalWorld.y)))
    const aridMask = clamp01(desertField * 0.72 + (1 - humidityNoise) * 0.28 + equator * 0.08 - rainforestField * 0.32)
    const fertileMask = clamp01(humidityNoise * 0.52 + rainforestField * 0.48 + equator * 0.14 - desertField * 0.28)
    const terrainNoise =
      0.5 +
      0.5 * (
        0.6 * sinLonLat(longitude, latitude, 9.2, 4.7) +
        0.22 * sinLonLat(longitude, latitude, 15.4, -15.4) +
        0.18 * Math.cos(normalWorld.x * 23.5 + normalWorld.z * 18.6)
      )
    const mountainMask = smoothstep(0.62, 0.9, terrainNoise) * landMask
    const vegetationBase = mixColor(
      { r: 0.08, g: 0.22, b: 0.07 },
      { r: 0.24, g: 0.45, b: 0.16 },
      fertileMask,
    )
    const drylandBase = mixColor(
      { r: 0.43, g: 0.35, b: 0.2 },
      { r: 0.78, g: 0.68, b: 0.38 },
      clamp01(aridMask * 0.9 + equator * 0.15),
    )
    const tundraBase = mixColor(
      { r: 0.36, g: 0.34, b: 0.28 },
      { r: 0.7, g: 0.72, b: 0.68 },
      latitudeCold,
    )
    let landBase = mixColor(vegetationBase, drylandBase, aridMask)
    landBase = mixColor(landBase, { r: 0.22, g: 0.33, b: 0.16 }, borealMask * 0.55)
    landBase = mixColor(landBase, tundraBase, latitudeCold * 0.72)
    landBase = mixColor(landBase, { r: 0.56, g: 0.54, b: 0.5 }, mountainMask * 0.34)

    const polarIce = smoothstep(0.7, 0.92, Math.abs(normalWorld.y))
    const antarcticIce = smoothstep(0.42, 0.78, -normalWorld.y)
    const greenlandIce = gaussianLobe(longitude, latitude, -42, 73, 13, 9, 1)
    const iceMask = clamp01(Math.max(polarIce * 0.74, antarcticIce * 0.98, greenlandIce * 0.88))

    const cloudField =
      0.44 * sinLonLat(longitude, latitude, 7.4, 3.8) +
      0.28 * sinLonLat(longitude, latitude, 12.6, -12.6) +
      0.18 * Math.cos(normalWorld.x * 18.2 + normalWorld.y * 7.4 - normalWorld.z * 11.8) +
      0.12 * sinLonLat(longitude, latitude, 15.6, -9.2)
    const cloudMask = smoothstep(0.42, 0.7, cloudField * 0.5 + 0.5)
    const cloudStrength = clamp01(cloudMask * (0.42 + oceanBase.b * 0.22 + equator * 0.12))
    const cloudColor = mixColor({ r: 0.84, g: 0.88, b: 0.92 }, { r: 0.98, g: 0.99, b: 1 }, cloudStrength)

    let base = mixColor(oceanBase, landBase, landMask)
    base = mixColor(base, { r: 0.95, g: 0.98, b: 1 }, iceMask)
    base = mixColor(base, cloudColor, cloudStrength * 0.5)
    const oceanFactor = (1 - landMask) * (1 - cloudStrength * 0.78)
    return {
      base: clampColor(base),
      ambient: 0.09,
      diffuseStrength: 0.94,
      atmosphereColor: { r: 0.22, g: 0.45, b: 0.84 },
      atmosphereStrength: 0.22,
      specularStrength: 0.48,
      gloss: 96,
      specularMask: oceanFactor,
    }
  }

  if (body.id === 'moon') {
    const maria =
      0.5 +
      0.5 * (
        0.54 * sinLonLat(longitude, latitude, 6.6, 3.2) +
        0.24 * cosLonLat(longitude, latitude, 11.8, -11.8) +
        0.22 * Math.sin(normalWorld.x * 18.4 + normalWorld.z * 12.7)
      )
    return {
      base: mixColor({ r: 0.38, g: 0.39, b: 0.4 }, { r: 0.74, g: 0.74, b: 0.76 }, maria),
      ambient: 0.08,
      diffuseStrength: 0.9,
      atmosphereColor: { r: 0.18, g: 0.18, b: 0.2 },
      atmosphereStrength: 0.01,
      specularStrength: 0.02,
      gloss: 12,
      specularMask: 0.08,
    }
  }

  if (body.id === 'io') {
    const sulfur =
      0.5 +
      0.5 * (
        0.62 * sinLonLat(longitude, latitude, 8.2, -3.8) +
        0.22 * cosLonLat(longitude, latitude, 13.1, 13.1) +
        0.16 * Math.sin(normalWorld.x * 17.7 - normalWorld.z * 14.5)
      )
    return {
      base: mixColor({ r: 0.62, g: 0.4, b: 0.1 }, { r: 0.96, g: 0.86, b: 0.24 }, sulfur),
      ambient: 0.11,
      diffuseStrength: 0.88,
      atmosphereColor: { r: 0.4, g: 0.22, b: 0.06 },
      atmosphereStrength: 0.012,
      specularStrength: 0.03,
      gloss: 16,
      specularMask: 0.1,
    }
  }

  if (body.id === 'europa') {
    const cracks =
      0.5 +
      0.5 * (
        0.58 * sinLonLat(longitude, latitude, 13.4, 5.4) +
        0.28 * sinLonLat(longitude, latitude, 17.2, -17.2) +
        0.14 * Math.cos(normalWorld.x * 22.5 + normalWorld.z * 16.8)
      )
    return {
      base: mixColor({ r: 0.68, g: 0.62, b: 0.54 }, { r: 0.92, g: 0.9, b: 0.84 }, cracks),
      ambient: 0.1,
      diffuseStrength: 0.9,
      atmosphereColor: { r: 0.3, g: 0.26, b: 0.22 },
      atmosphereStrength: 0.01,
      specularStrength: 0.04,
      gloss: 22,
      specularMask: 0.12,
    }
  }

  if (body.id === 'ganymede') {
    const iceBands =
      0.5 +
      0.5 * (
        0.52 * sinLonLat(longitude, latitude, 7.3, 4.6) +
        0.26 * cosLonLat(longitude, latitude, 9.4, 9.4) +
        0.22 * Math.sin(normalWorld.y * 18.2 - normalWorld.z * 8.1)
      )
    return {
      base: mixColor({ r: 0.36, g: 0.36, b: 0.34 }, { r: 0.76, g: 0.76, b: 0.72 }, iceBands),
      ambient: 0.1,
      diffuseStrength: 0.88,
      atmosphereColor: { r: 0.24, g: 0.24, b: 0.24 },
      atmosphereStrength: 0.01,
      specularStrength: 0.03,
      gloss: 18,
      specularMask: 0.1,
    }
  }

  if (body.id === 'callisto') {
    const scars =
      0.5 +
      0.5 * (
        0.48 * sinLonLat(longitude, latitude, 9.7, -2.6) +
        0.32 * cosLonLat(longitude, latitude, 10.8, 10.8) +
        0.2 * Math.sin(normalWorld.x * 20.4 + normalWorld.z * 13.6)
      )
    return {
      base: mixColor({ r: 0.18, g: 0.16, b: 0.15 }, { r: 0.52, g: 0.46, b: 0.4 }, scars),
      ambient: 0.09,
      diffuseStrength: 0.88,
      atmosphereColor: { r: 0.18, g: 0.16, b: 0.14 },
      atmosphereStrength: 0.01,
      specularStrength: 0.02,
      gloss: 14,
      specularMask: 0.08,
    }
  }

  if (body.id === 'titan') {
    const haze =
      0.5 +
      0.5 * (
        0.52 * sinLonLat(longitude, latitude, 2.4, 7.2) +
        0.24 * sinLonLat(longitude, latitude, 5.6, -4.7) +
        0.14 * Math.cos(normalWorld.x * 10.8 + normalWorld.z * 8.9)
      )
    return {
      base: mixColor({ r: 0.5, g: 0.32, b: 0.12 }, { r: 0.9, g: 0.66, b: 0.28 }, haze),
      ambient: 0.12,
      diffuseStrength: 0.86,
      atmosphereColor: { r: 0.96, g: 0.72, b: 0.28 },
      atmosphereStrength: 0.08,
      specularStrength: 0.05,
      gloss: 18,
      specularMask: 0.16,
    }
  }

  if (body.id === 'triton') {
    const frost =
      0.5 +
      0.5 * (
        0.46 * sinLonLat(longitude, latitude, 6.8, 2.8) +
        0.3 * cosLonLat(longitude, latitude, 9.1, -9.1) +
        0.24 * Math.sin(normalWorld.x * 14.6 - normalWorld.z * 10.2)
      )
    return {
      base: mixColor({ r: 0.62, g: 0.56, b: 0.62 }, { r: 0.9, g: 0.88, b: 0.94 }, frost),
      ambient: 0.1,
      diffuseStrength: 0.88,
      atmosphereColor: { r: 0.42, g: 0.34, b: 0.46 },
      atmosphereStrength: 0.015,
      specularStrength: 0.03,
      gloss: 18,
      specularMask: 0.1,
    }
  }

  if (body.id === 'mercury') {
    const craterNoise =
      0.42 * sinLonLat(longitude, latitude, 7.2) +
      0.34 * Math.cos(latitude * 11.4) +
      0.24 * sinLonLat(longitude, latitude, 13.1, 13.1)
    const craterMix = craterNoise * 0.5 + 0.5
    return {
      base: mixColor({ r: 0.28, g: 0.25, b: 0.22 }, { r: 0.64, g: 0.58, b: 0.5 }, craterMix),
      ambient: 0.08,
      diffuseStrength: 0.9,
      atmosphereColor: { r: 0.18, g: 0.16, b: 0.14 },
      atmosphereStrength: 0.02,
      specularStrength: 0.03,
      gloss: 14,
      specularMask: 0.12,
    }
  }

  if (body.id === 'venus') {
    const cloudNoise =
      0.56 * sinLonLat(longitude, latitude, 1.7, 10.4) +
      0.44 * sinLonLat(longitude, latitude, 5.2, -3.4)
    const cloudMix = cloudNoise * 0.5 + 0.5
    return {
      base: mixColor({ r: 0.58, g: 0.44, b: 0.18 }, { r: 0.98, g: 0.88, b: 0.62 }, cloudMix),
      ambient: 0.13,
      diffuseStrength: 0.9,
      atmosphereColor: { r: 0.94, g: 0.8, b: 0.48 },
      atmosphereStrength: 0.09,
      specularStrength: 0.16,
      gloss: 26,
      specularMask: 0.46,
    }
  }

  if (body.id === 'mars') {
    const dustNoise =
      0.52 * sinLonLat(longitude, latitude, 4.1, 2.8) +
      0.3 * Math.cos(latitude * 9.2) +
      0.22 * sinLonLat(longitude, latitude, 8.6, -8.6)
    const dustMix = dustNoise * 0.5 + 0.5
    return {
      base: mixColor({ r: 0.34, g: 0.12, b: 0.08 }, { r: 0.82, g: 0.38, b: 0.18 }, dustMix),
      ambient: 0.09,
      diffuseStrength: 0.9,
      atmosphereColor: { r: 0.4, g: 0.2, b: 0.1 },
      atmosphereStrength: 0.035,
      specularStrength: 0.04,
      gloss: 16,
      specularMask: 0.16,
    }
  }

  if (body.id === 'jupiter') {
    const bands = 0.5 + 0.5 * Math.sin(latitude * 18 + sinLonLat(longitude, latitude, 3.4) * 1.2)
    const storm = smoothstep(0.72, 0.92, 0.5 + 0.5 * sinLonLat(longitude, latitude, 5.7, -8.6)) * smoothstep(0.3, 1, equator)
    const bandBase = mixColor({ r: 0.64, g: 0.46, b: 0.3 }, { r: 0.94, g: 0.82, b: 0.66 }, bands)
    return {
      base: mixColor(bandBase, { r: 0.78, g: 0.38, b: 0.22 }, storm * 0.45),
      ambient: 0.13,
      diffuseStrength: 0.84,
      atmosphereColor: { r: 0.86, g: 0.7, b: 0.48 },
      atmosphereStrength: 0.055,
      specularStrength: 0.08,
      gloss: 20,
      specularMask: 0.24,
    }
  }

  if (body.id === 'saturn') {
    const bands = 0.5 + 0.5 * Math.sin(latitude * 21 + sinLonLat(longitude, latitude, 2.3) * 0.9)
    return {
      base: mixColor({ r: 0.72, g: 0.62, b: 0.4 }, { r: 0.96, g: 0.88, b: 0.68 }, bands),
      ambient: 0.13,
      diffuseStrength: 0.84,
      atmosphereColor: { r: 0.94, g: 0.82, b: 0.58 },
      atmosphereStrength: 0.05,
      specularStrength: 0.07,
      gloss: 18,
      specularMask: 0.2,
    }
  }

  if (body.id === 'uranus') {
    const haze = 0.5 + 0.5 * sinLonLat(longitude, latitude, 1.1, 8.4) * 0.2
    return {
      base: mixColor({ r: 0.44, g: 0.72, b: 0.74 }, { r: 0.72, g: 0.94, b: 0.96 }, haze),
      ambient: 0.14,
      diffuseStrength: 0.82,
      atmosphereColor: { r: 0.7, g: 0.94, b: 0.95 },
      atmosphereStrength: 0.07,
      specularStrength: 0.06,
      gloss: 20,
      specularMask: 0.18,
    }
  }

  const storms = smoothstep(0.74, 0.95, 0.5 + 0.5 * sinLonLat(longitude, latitude, 6.1, -5.3)) * smoothstep(0.2, 1, equator)
  const bands = 0.5 + 0.5 * sinLonLat(longitude, latitude, 1.4, 12.6)
  return {
    base: mixColor(
      { r: 0.14, g: 0.24, b: 0.56 },
      mixColor({ r: 0.26, g: 0.44, b: 0.82 }, { r: 0.78, g: 0.88, b: 0.98 }, storms * 0.35),
      bands,
    ),
    ambient: 0.13,
    diffuseStrength: 0.84,
    atmosphereColor: { r: 0.48, g: 0.68, b: 0.96 },
    atmosphereStrength: 0.1,
    specularStrength: 0.07,
    gloss: 22,
    specularMask: 0.22,
  }
}

function renderPlanets(metrics: Metrics, camera: CameraTransform): void {
  const orientationFrames = new Map<string, BodyOrientationFrame>()
  for (let index = 0; index < renderableBodies.length; index++) {
    const body = renderableBodies[index]!
    orientationFrames.set(body.id, getBodyOrientationFrame(body, state.simulationTimeMs))
  }

  for (let row = 0; row < metrics.rows; row++) {
    const screenY = (metrics.rows * 0.5 - (row + 0.5)) / metrics.projection.focalY
    for (let col = 0; col < metrics.cols; col++) {
      const screenX = (col + 0.5 - metrics.cols * 0.5) / metrics.projection.focalX
      const rayWorld = normalizeVec3(addVec3(
        addVec3(scaleVec3(camera.right, screenX), scaleVec3(camera.up, screenY)),
        camera.forward,
      ))
      let hitBody: CelestialBody | null = null
      let hitT = Number.POSITIVE_INFINITY

      for (let index = 0; index < renderableBodies.length; index++) {
        const body = renderableBodies[index]!
        const t = intersectSphere(camera.position, rayWorld, body.center, body.radius)
        if (t !== null && t < hitT) {
          hitT = t
          hitBody = body
        }
      }

      if (hitBody === null) continue

      const worldPoint = addVec3(camera.position, scaleVec3(rayWorld, hitT))
      const normalWorld = normalizeVec3(subtractVec3(worldPoint, hitBody.center))
      const orientationFrame = orientationFrames.get(hitBody.id)!
      const normalBody = worldNormalToBodyNormal(normalWorld, orientationFrame)
      const viewDirectionWorld = scaleVec3(rayWorld, -1)
      const sunDirectionWorld = normalizeVec3(subtractVec3(sunBody.center, worldPoint))
      const sunFacing = dotVec3(normalWorld, sunDirectionWorld)
      const diffuse = Math.max(0, sunFacing)
      const rim = Math.pow(Math.max(0, 1 - dotVec3(normalWorld, viewDirectionWorld)), 3)
      const halfVector = normalizeVec3(addVec3(sunDirectionWorld, viewDirectionWorld))
      const sample = getPlanetSurfaceSample(hitBody, normalBody)
      const solarLightScale = getVisualSolarLightScale(hitBody, state.simulationTimeMs)
      const ambientScale = 0.8 + 0.2 * solarLightScale
      const specular = Math.pow(Math.max(0, dotVec3(normalWorld, halfVector)), sample.gloss) *
        sample.specularMask *
        sample.specularStrength *
        solarLightScale
      const sunLit = multiplyColor(
        sample.base,
        sample.ambient * ambientScale + diffuse * sample.diffuseStrength * solarLightScale,
      )
      const warmLight = {
        r: sunLit.r * SUN_COLOR.r,
        g: sunLit.g * SUN_COLOR.g,
        b: sunLit.b * SUN_COLOR.b,
      }
      const horizonLight = smoothstep(-0.16, 0.18, sunFacing)
      const atmosphere = multiplyColor(
        sample.atmosphereColor,
        rim * horizonLight * sample.atmosphereStrength * (0.74 + 0.26 * solarLightScale),
      )
      const glitter = {
        r: specular * 0.75,
        g: specular * 0.74,
        b: specular * 0.72,
      }
      const shaded = clampColor(toneMapColor(addColor(addColor(warmLight, atmosphere), glitter)))

      const index = row * metrics.cols + col
      if (hitT >= state.depthField[index]!) continue
      state.depthField[index] = hitT
      state.redField[index] = shaded.r
      state.greenField[index] = shaded.g
      state.blueField[index] = shaded.b
    }
  }
}

function renderStars(metrics: Metrics, previousCamera: CameraTransform, currentCamera: CameraTransform): void {
  syncStarCount()

  for (let index = 0; index < stars.length; index++) {
    const star = stars[index]!
    const previous = directionToCamera(star.direction, previousCamera)
    const current = directionToCamera(star.direction, currentCamera)
    if (current.z <= 0.001) continue

    const currentProjected = projectPoint(current, metrics.projection, metrics.cols, metrics.rows)
    if (
      currentProjected.x < -OUTSIDE_MARGIN ||
      currentProjected.x > metrics.cols + OUTSIDE_MARGIN ||
      currentProjected.y < -OUTSIDE_MARGIN ||
      currentProjected.y > metrics.rows + OUTSIDE_MARGIN
    ) {
      continue
    }

    const brightness = star.intensity
    const headColor = multiplyColor(star.tint, brightness)

    if (previous.z > 0.001) {
      const previousProjected = projectPoint(previous, metrics.projection, metrics.cols, metrics.rows)
      const projectedDistance = Math.hypot(
        currentProjected.x - previousProjected.x,
        currentProjected.y - previousProjected.y,
      )
      if (projectedDistance > 0.02) {
        const trailStrength = Math.min(0.28, 0.06 + projectedDistance * 0.02)
        stampProjectedTrail(
          previousProjected.x,
          previousProjected.y,
          currentProjected.x,
          currentProjected.y,
          headColor,
          trailStrength,
          metrics.cols,
          metrics.rows,
        )
      }
    }

    splatProjectedColor(
      currentProjected.x,
      currentProjected.y,
      headColor,
      0.32 + brightness * 0.38,
      STAR_DEPTH,
      metrics.cols,
      metrics.rows,
    )
  }
}

function renderSaturnRing(metrics: Metrics, camera: CameraTransform): void {
  syncSaturnRingParticles()

  const saturnFrame = getBodyOrientationFrame(saturnBody, state.simulationTimeMs)
  const ringNormal = saturnFrame.north
  const fallbackAxis = Math.abs(dotVec3(ringNormal, SOLAR_PRIMARY_AXIS)) > 0.94 ? SOLAR_LATERAL_AXIS : SOLAR_PRIMARY_AXIS
  const ringAxisA = normalizeVec3(crossVec3(ringNormal, fallbackAxis))
  const ringAxisB = normalizeVec3(crossVec3(ringNormal, ringAxisA))

  for (let index = 0; index < saturnRingParticles.length; index++) {
    const particle = saturnRingParticles[index]!
    const radial = saturnBody.radius * particle.radiusFactor
    const worldPoint = addVec3(
      addVec3(
        addVec3(
          saturnBody.center,
          scaleVec3(ringAxisA, Math.cos(particle.angle) * radial),
        ),
        scaleVec3(ringAxisB, Math.sin(particle.angle) * radial),
      ),
      scaleVec3(ringNormal, saturnBody.radius * particle.heightFactor),
    )
    const cameraPoint = worldToCamera(worldPoint, camera)
    if (cameraPoint.z <= NEAR_Z) continue

    const projected = projectPoint(cameraPoint, metrics.projection, metrics.cols, metrics.rows)
    const radiusX = Math.max(0.35, (metrics.projection.focalX * particle.size) / cameraPoint.z)
    const radiusY = Math.max(0.25, (metrics.projection.focalY * particle.size * 0.65) / cameraPoint.z)
    const warmDust = mixColor(
      { r: 0.66, g: 0.6, b: 0.52 },
      { r: 0.92, g: 0.84, b: 0.68 },
      particle.brightness,
    )
    const solarLightScale = getVisualSolarLightScale(saturnBody, state.simulationTimeMs)
    addDiskGlow(projected.x, projected.y, radiusX, radiusY, cameraPoint.z, metrics.cols, metrics.rows, normalizedDistance => {
      if (normalizedDistance > 1) return null
      const glow = Math.pow(clamp01(1 - normalizedDistance), 1.8) * particle.brightness
      if (glow < 0.08) return null
      return toneMapColor(multiplyColor(warmDust, glow * 0.92 * solarLightScale))
    })
  }
}

function getBodyOverlayTarget(metrics: Metrics, camera: CameraTransform): BodyOverlayTarget | null {
  let best: (BodyOverlayTarget & { score: number }) | null = null

  for (let index = 0; index < celestialBodies.length; index++) {
    const body = celestialBodies[index]!
    const bodyCamera = worldToCamera(body.center, camera)
    if (bodyCamera.z <= NEAR_Z) continue

    const projected = projectPoint(bodyCamera, metrics.projection, metrics.cols, metrics.rows)
    const screenRadiusX = Math.abs((metrics.projection.focalX * body.radius) / bodyCamera.z)
    const screenRadiusY = Math.abs((metrics.projection.focalY * body.radius) / bodyCamera.z)
    const surfaceDistance = Math.max(0, distanceVec3(camera.position, body.center) - body.radius)
    const onScreen =
      projected.x >= -screenRadiusX &&
      projected.x <= metrics.cols + screenRadiusX &&
      projected.y >= -screenRadiusY &&
      projected.y <= metrics.rows + screenRadiusY
    const closeEnough =
      surfaceDistance <= body.infoDistance ||
      Math.max(screenRadiusX, screenRadiusY) >= body.minScreenRadius
    if (!onScreen || !closeEnough) continue

    const centerDistance = Math.hypot(projected.x - metrics.cols * 0.5, projected.y - metrics.rows * 0.5)
    const score = Math.max(screenRadiusX, screenRadiusY) * 4 - surfaceDistance * 0.08 - centerDistance * 0.2
    if (best === null || score > best.score) {
      best = {
        body,
        screenX: metrics.left + projected.x * metrics.cellWidth,
        screenY: metrics.top + projected.y * metrics.lineHeight,
        screenRadiusX: screenRadiusX * metrics.cellWidth,
        screenRadiusY: screenRadiusY * metrics.lineHeight,
        surfaceDistance,
        focusDistance: Math.hypot(
          metrics.left + projected.x * metrics.cellWidth - (metrics.left + metrics.blockWidth * 0.5),
          metrics.top + projected.y * metrics.lineHeight - (metrics.top + metrics.blockHeight * 0.5),
        ),
        score,
      }
    }
  }

  if (best === null) return null
  return {
    body: best.body,
    screenX: best.screenX,
    screenY: best.screenY,
    screenRadiusX: best.screenRadiusX,
    screenRadiusY: best.screenRadiusY,
    surfaceDistance: best.surfaceDistance,
    focusDistance: best.focusDistance,
  }
}

function shouldOfferBriefPrompt(target: BodyOverlayTarget): boolean {
  const focusThreshold = Math.max(
    68,
    Math.min(196, Math.max(target.screenRadiusX, target.screenRadiusY) * 1.65 + 34),
  )
  return (
    getCurrentSpeed() <= BRIEF_PROMPT_SPEED_MAX &&
    target.surfaceDistance <= target.body.infoDistance * BRIEF_TARGET_DISTANCE_MULTIPLIER &&
    target.focusDistance <= focusThreshold
  )
}

function updateBodyOverlayState(dt: number, camera: CameraTransform): void {
  const metrics = state.metrics
  if (metrics === null) return
  if (!state.flightStarted) {
    state.briefPromptBodyId = null
    state.briefOpenBodyId = null
    state.briefReveal = 0
    return
  }

  const target = getBodyOverlayTarget(metrics, camera)
  state.briefPromptBodyId =
    state.briefOpenBodyId === null && target !== null && shouldOfferBriefPrompt(target)
      ? target.body.id
      : null

  const revealDirection = state.briefOpenBodyId === null ? -1 : 1
  if (dt === 0) {
    state.briefReveal = revealDirection > 0 ? 1 : 0
    return
  }
  const nextReveal = state.briefReveal + revealDirection * dt * BRIEF_REVEAL_SPEED
  state.briefReveal = clamp01(nextReveal)
}

function handleSpaceInteraction(): boolean {
  if (state.briefOpenBodyId !== null) {
    state.briefOpenBodyId = null
    return true
  }

  if (state.briefPromptBodyId !== null) {
    state.briefOpenBodyId = state.briefPromptBodyId
    state.camera.velocity = { x: 0, y: 0, z: 0 }
    return true
  }

  return false
}

function buildRows(previousCamera: CameraTransform, currentCamera: CameraTransform): RowRun[][] {
  const metrics = state.metrics
  const palette = state.palette
  if (metrics === null || palette === null) return []

  clearBuffers()
  renderPlanets(metrics, currentCamera)
  renderStars(metrics, previousCamera, currentCamera)
  renderSaturnRing(metrics, currentCamera)
  renderSun(metrics, currentCamera)

  const rows: RowRun[][] = Array.from({ length: metrics.rows }, () => [])
  for (let row = 0; row < metrics.rows; row++) {
    const rowRuns = rows[row]!
    const rowOffset = row * metrics.cols
    let runStart = 0
    let runText = ''
    let runColor: string | null = null

    for (let col = 0; col < metrics.cols; col++) {
      const index = rowOffset + col
      const color = clampColor({
        r: state.redField[index]!,
        g: state.greenField[index]!,
        b: state.blueField[index]!,
      })
      const lum = luminance(color)
      const char = palette.lookup[Math.round(clamp01(lum) * 255)]!
      const cssColor = toCssColor(color)

      if (runColor === null) {
        runColor = cssColor
        runStart = col
        runText = char
        continue
      }

      if (cssColor === runColor) {
        runText += char
        continue
      }

      rowRuns.push({ startCol: runStart, text: runText, color: runColor })
      runColor = cssColor
      runStart = col
      runText = char
    }

    if (runColor !== null) {
      rowRuns.push({ startCol: runStart, text: runText, color: runColor })
    }
  }

  return rows
}

function drawPanelFrame(x: number, y: number, width: number, height: number, accent: Rgb, alpha: number): void {
  ctx.save()
  ctx.globalAlpha = clamp01(alpha)
  ctx.fillStyle = 'rgb(0 0 0 / 0.84)'
  ctx.fillRect(x, y, width, height)
  ctx.strokeStyle = toCssColorAlpha(accent, 0.5)
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1)

  ctx.strokeStyle = toCssColorAlpha(accent, 0.24)
  ctx.beginPath()
  ctx.moveTo(x + 11, y + 11)
  ctx.lineTo(x + 34, y + 11)
  ctx.moveTo(x + 11, y + 11)
  ctx.lineTo(x + 11, y + 34)
  ctx.moveTo(x + width - 11, y + 11)
  ctx.lineTo(x + width - 34, y + 11)
  ctx.moveTo(x + width - 11, y + 11)
  ctx.lineTo(x + width - 11, y + 34)
  ctx.moveTo(x + 11, y + height - 11)
  ctx.lineTo(x + 34, y + height - 11)
  ctx.moveTo(x + 11, y + height - 11)
  ctx.lineTo(x + 11, y + height - 34)
  ctx.moveTo(x + width - 11, y + height - 11)
  ctx.lineTo(x + width - 34, y + height - 11)
  ctx.moveTo(x + width - 11, y + height - 11)
  ctx.lineTo(x + width - 11, y + height - 34)
  ctx.stroke()

  ctx.restore()
}

function drawPanelSweep(x: number, y: number, width: number, height: number, accent: Rgb, alpha: number, phase: number): void {
  ctx.save()
  ctx.globalAlpha = clamp01(alpha)
  ctx.beginPath()
  ctx.rect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2))
  ctx.clip()

  const sweepY = y - 18 + clamp01(phase) * (height + 36)
  const gradient = ctx.createLinearGradient(0, sweepY - 18, 0, sweepY + 18)
  gradient.addColorStop(0, toCssColorAlpha(accent, 0))
  gradient.addColorStop(0.5, toCssColorAlpha(accent, 0.18))
  gradient.addColorStop(1, toCssColorAlpha(accent, 0))
  ctx.fillStyle = gradient
  ctx.fillRect(x, sweepY - 18, width, 36)

  ctx.strokeStyle = toCssColorAlpha(accent, 0.16)
  ctx.beginPath()
  ctx.moveTo(x + 12, sweepY + 0.5)
  ctx.lineTo(x + width - 12, sweepY + 0.5)
  ctx.stroke()
  ctx.restore()
}

function clampGuidePointToViewportEdge(x: number, y: number, width: number, height: number): { x: number, y: number } {
  const centerX = width * 0.5
  const centerY = height * 0.5
  let dx = x - centerX
  let dy = y - centerY

  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) {
    dx = 0
    dy = height * 0.5 - GUIDE_EDGE_INSET
  }

  const maxX = Math.max(1, width * 0.5 - GUIDE_EDGE_INSET)
  const maxY = Math.max(1, height * 0.5 - GUIDE_EDGE_INSET)
  const scale = 1 / Math.max(Math.abs(dx) / maxX, Math.abs(dy) / maxY, 1)
  return {
    x: centerX + dx * scale,
    y: centerY + dy * scale,
  }
}

function getBodyTelemetryRows(target: BodyOverlayTarget): InfoDatum[] {
  const body = target.body
  const rows: InfoDatum[] = [
    { label: 'range', value: `${target.surfaceDistance.toFixed(1)}u` },
  ]
  const heliocentricDistance = getHeliocentricDistanceAu(body, state.simulationTimeMs)
  if (heliocentricDistance !== null) {
    rows.unshift({ label: 'solar', value: formatAstronomicalUnits(heliocentricDistance) })
  }
  rows.push(...body.briefData)
  return rows
}

function drawBodyMeasurementGuide(target: BodyOverlayTarget, onRight: boolean, reveal: number): void {
  const sign = onRight ? 1 : -1
  const anchorX = target.screenX + sign * (target.screenRadiusX + BRIEF_MEASURE_OFFSET)
  const radiusX = anchorX
  const radiusTop = lerp(target.screenY, target.screenY - target.screenRadiusY, reveal)
  const earthRatio = earthBody.physicalRadiusKm / Math.max(1, target.body.physicalRadiusKm)
  const earthRadiusSpan = clamp(target.screenRadiusY * earthRatio, 2.5, Math.max(12, target.screenRadiusY * 3))
  const earthX = anchorX + sign * 18
  const earthTop = lerp(target.screenY, target.screenY - earthRadiusSpan, reveal)
  const textOffset = sign * 10

  ctx.save()
  ctx.globalAlpha = clamp01(reveal)
  ctx.strokeStyle = toCssColorAlpha(target.body.accent, 0.86)
  ctx.fillStyle = toCssColorAlpha(target.body.accent, 0.94)
  ctx.lineWidth = 1
  ctx.textAlign = onRight ? 'left' : 'right'

  ctx.beginPath()
  ctx.moveTo(target.screenX + sign * target.screenRadiusX * 0.68, target.screenY)
  ctx.lineTo(radiusX, target.screenY)
  ctx.moveTo(radiusX, target.screenY)
  ctx.lineTo(radiusX, radiusTop)
  ctx.moveTo(radiusX - 5, radiusTop)
  ctx.lineTo(radiusX + 5, radiusTop)
  ctx.stroke()

  if (target.body.id !== earthBody.id) {
    ctx.strokeStyle = 'rgb(190 214 255 / 0.78)'
    ctx.fillStyle = 'rgb(210 228 255 / 0.9)'
    ctx.beginPath()
    ctx.moveTo(earthX, target.screenY)
    ctx.lineTo(earthX, earthTop)
    ctx.moveTo(earthX, target.screenY)
    ctx.lineTo(earthX - sign * 8, target.screenY)
    ctx.moveTo(earthX - 4, earthTop)
    ctx.lineTo(earthX + 4, earthTop)
    ctx.stroke()
  }

  ctx.font = `600 11px ${FONT_FAMILY}`
  ctx.fillText(
    `radius ${formatKilometers(target.body.physicalRadiusKm)}`,
    radiusX + textOffset,
    lerp(target.screenY, radiusTop, 0.45),
  )
  if (target.body.id !== earthBody.id) {
    ctx.fillStyle = 'rgb(210 228 255 / 0.9)'
    ctx.fillText('earth', earthX + textOffset, lerp(target.screenY, earthTop, 0.45))
  }
  ctx.restore()
}

function drawPlanetGuides(camera: CameraTransform): void {
  const metrics = state.metrics
  if (metrics === null) return

  const width = getCanvasCssWidth()
  const height = getCanvasCssHeight()
  const overlayTarget = getBodyOverlayTarget(metrics, camera)
  const occupiedRects: Array<{ left: number, right: number, top: number, bottom: number }> = []
  const guides = planetBodies
    .filter(body => body.id !== overlayTarget?.body.id)
    .map(body => {
      const bodyCamera = worldToCamera(body.center, camera)
      let x = width * 0.5
      let y = height * 0.5
      let edgeClamped = true

      if (bodyCamera.z > NEAR_Z) {
        const projected = projectPoint(bodyCamera, metrics.projection, metrics.cols, metrics.rows)
        const screenX = metrics.left + projected.x * metrics.cellWidth
        const screenY = metrics.top + projected.y * metrics.lineHeight
        const screenRadiusY = Math.abs((metrics.projection.focalY * body.radius) / bodyCamera.z) * metrics.lineHeight
        const guideY = screenY - Math.max(10, screenRadiusY) - GUIDE_LABEL_GAP
        const onScreen =
          screenX >= GUIDE_EDGE_INSET &&
          screenX <= width - GUIDE_EDGE_INSET &&
          guideY >= GUIDE_EDGE_INSET &&
          guideY <= height - GUIDE_EDGE_INSET

        if (onScreen) {
          x = screenX
          y = guideY
          edgeClamped = false
        } else {
          const clamped = clampGuidePointToViewportEdge(screenX, screenY, width, height)
          x = clamped.x
          y = clamped.y
        }
      } else {
        const proxy = projectPoint(
          {
            x: bodyCamera.x,
            y: bodyCamera.y,
            z: Math.max(Math.abs(bodyCamera.z), NEAR_Z),
          },
          metrics.projection,
          metrics.cols,
          metrics.rows,
        )
        const clamped = clampGuidePointToViewportEdge(
          metrics.left + proxy.x * metrics.cellWidth,
          metrics.top + proxy.y * metrics.lineHeight,
          width,
          height,
        )
        x = clamped.x
        y = clamped.y
      }

      return { body, x, y, edgeClamped }
    })
    .sort((a, b) => Number(a.edgeClamped) - Number(b.edgeClamped) || a.y - b.y || a.x - b.x)

  ctx.save()
  ctx.font = GUIDE_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (let index = 0; index < guides.length; index++) {
    const guide = guides[index]!
    const cachedLabelWidth = guideWidthCache.get(guide.body.id)
    const labelWidth = cachedLabelWidth ?? Math.ceil(ctx.measureText(guide.body.name).width + GUIDE_PADDING_X * 2)
    if (cachedLabelWidth === undefined) guideWidthCache.set(guide.body.id, labelWidth)
    const minX = GUIDE_EDGE_INSET + labelWidth * 0.5
    const maxX = width - GUIDE_EDGE_INSET - labelWidth * 0.5
    const minY = GUIDE_EDGE_INSET + GUIDE_HEIGHT * 0.5
    const maxY = height - GUIDE_EDGE_INSET - GUIDE_HEIGHT * 0.5
    const labelX = clamp(guide.x, minX, maxX)
    const baseY = clamp(guide.y, minY, maxY)
    let labelY = baseY
    let boxY = labelY - GUIDE_HEIGHT * 0.5

    for (let attempt = 0; attempt < 6; attempt++) {
      const boxX = labelX - labelWidth * 0.5
      const overlaps = occupiedRects.some(rect => {
        return !(
          boxX + labelWidth + 6 <= rect.left ||
          boxX >= rect.right + 6 ||
          boxY + GUIDE_HEIGHT + 5 <= rect.top ||
          boxY >= rect.bottom + 5
        )
      })
      if (!overlaps) break

      const step = GUIDE_HEIGHT + 4
      const offsetIndex = Math.floor(attempt * 0.5) + 1
      const direction = attempt % 2 === 0 ? 1 : -1
      labelY = clamp(baseY + direction * offsetIndex * step, minY, maxY)
      boxY = labelY - GUIDE_HEIGHT * 0.5
    }

    const boxX = labelX - labelWidth * 0.5
    occupiedRects.push({
      left: boxX,
      right: boxX + labelWidth,
      top: boxY,
      bottom: boxY + GUIDE_HEIGHT,
    })

    ctx.fillStyle = 'rgb(0 0 0 / 0.78)'
    ctx.fillRect(boxX, boxY, labelWidth, GUIDE_HEIGHT)
    ctx.strokeStyle = toCssColorAlpha(guide.body.accent, guide.edgeClamped ? 0.84 : 0.6)
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, labelWidth - 1, GUIDE_HEIGHT - 1)
    ctx.fillStyle = '#eef2f5'
    ctx.fillText(guide.body.name, labelX, labelY + 0.5)
  }

  ctx.restore()
}

function drawBodyOverlay(camera: CameraTransform): void {
  const metrics = state.metrics
  if (metrics === null) return

  const target = getBodyOverlayTarget(metrics, camera)
  if (target === null) return

  const width = getCanvasCssWidth()
  const height = getCanvasCssHeight()
  const briefReveal = state.briefOpenBodyId === target.body.id ? smoothstep(0, 1, state.briefReveal) : 0
  const briefPromptVisible = state.briefPromptBodyId === target.body.id && briefReveal < 0.08
  const summaryLines = getWrappedInfoLines(target.body.summary, INFO_CARD_WIDTH - INFO_CARD_PADDING * 2)
  const telemetryRows = getBodyTelemetryRows(target)
  const rowHeight = 18
  const summaryGap = 8
  const telemetryHeaderGap = 14
  const expandedHeight =
    INFO_CARD_PADDING * 2 +
    16 +
    14 +
    summaryLines.length * INFO_LINE_HEIGHT +
    summaryGap +
    12 +
    telemetryHeaderGap +
    telemetryRows.length * rowHeight +
    10
  const cardWidth = lerp(INFO_BADGE_WIDTH, INFO_CARD_WIDTH, briefReveal)
  const cardHeight = lerp(INFO_BADGE_HEIGHT, expandedHeight, briefReveal)

  const cardOnRight = target.screenX <= width * 0.52
  const guideOnRight = !cardOnRight
  const anchorX = cardOnRight
    ? target.screenX + target.screenRadiusX + INFO_POINTER_OFFSET
    : target.screenX - target.screenRadiusX - INFO_POINTER_OFFSET
  const cardX = clamp(
    cardOnRight ? anchorX : anchorX - cardWidth,
    INFO_CARD_MARGIN,
    width - cardWidth - INFO_CARD_MARGIN,
  )
  const cardY = clamp(
    target.screenY - cardHeight * lerp(0.5, 0.42, briefReveal),
    INFO_CARD_MARGIN,
    height - cardHeight - INFO_CARD_MARGIN,
  )
  const pointerX = cardOnRight ? cardX : cardX + cardWidth
  const pointerY = clamp(target.screenY, cardY + 12, cardY + Math.max(12, cardHeight - 12))
  const textX = cardX + INFO_CARD_PADDING
  let textY = cardY + INFO_CARD_PADDING + 13

  ctx.strokeStyle = toCssColorAlpha(target.body.accent, 0.9)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(target.screenX, target.screenY)
  ctx.lineTo(pointerX, pointerY)
  ctx.stroke()

  ctx.fillStyle = toCssColorAlpha(target.body.accent, 0.9)
  ctx.beginPath()
  ctx.arc(target.screenX, target.screenY, 2.5, 0, Math.PI * 2)
  ctx.fill()

  drawPanelFrame(cardX, cardY, cardWidth, cardHeight, target.body.accent, 1)
  if (briefPromptVisible) {
    const pulse = 0.38 + Math.sin(performance.now() * 0.01) * 0.18
    ctx.strokeStyle = toCssColorAlpha(target.body.accent, pulse)
    ctx.strokeRect(cardX + 2.5, cardY + 2.5, cardWidth - 5, cardHeight - 5)
  }
  if (briefReveal > 0.02) {
    drawPanelSweep(cardX, cardY, cardWidth, cardHeight, target.body.accent, Math.min(1, briefReveal * 1.15), briefReveal)
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(cardX + 1, cardY + 1, Math.max(0, cardWidth - 2), Math.max(0, cardHeight - 2))
  ctx.clip()
  ctx.font = `600 ${INFO_FONT_SIZE}px ${FONT_FAMILY}`
  ctx.fillStyle = '#f2f2f2'
  if (briefReveal < 0.02) {
    ctx.textBaseline = 'middle'
    ctx.fillText(target.body.name, textX, cardY + cardHeight * 0.5 + 0.5)
    ctx.textBaseline = 'alphabetic'
  } else {
    ctx.fillText(target.body.name, textX, textY)
  }
  if (briefPromptVisible) {
    ctx.fillStyle = toCssColorAlpha(target.body.accent, 0.92)
    ctx.beginPath()
    ctx.arc(cardX + cardWidth - INFO_CARD_PADDING - 4, textY - 4, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
  if (briefReveal > 0.02) {
    const contentAlpha = clamp01(briefReveal * 1.18)
    textY += 16
    ctx.globalAlpha = contentAlpha
    ctx.font = INFO_FONT
    ctx.fillStyle = toCssColorAlpha(target.body.accent, 0.9)
    ctx.fillText(target.body.kind, textX, textY)
    textY += 19

    ctx.fillStyle = '#d8d8d8'
    for (let index = 0; index < summaryLines.length; index++) {
      const line = summaryLines[index]!
      ctx.fillText(line, textX, textY)
      textY += INFO_LINE_HEIGHT
    }

    textY += summaryGap
    ctx.font = `600 11px ${FONT_FAMILY}`
    ctx.fillStyle = toCssColorAlpha(target.body.accent, 0.88)
    ctx.fillText('telemetry', textX, textY)
    const telemetryTop = textY + telemetryHeaderGap - 12

    const dividerX = textX + 76
    ctx.strokeStyle = toCssColorAlpha(target.body.accent, 0.18)
    ctx.beginPath()
    ctx.moveTo(dividerX + 0.5, telemetryTop)
    ctx.lineTo(dividerX + 0.5, telemetryTop + telemetryRows.length * rowHeight)
    ctx.stroke()

    ctx.textBaseline = 'middle'
    for (let index = 0; index < telemetryRows.length; index++) {
      const row = telemetryRows[index]!
      const rowTop = telemetryTop + index * rowHeight
      const rowCenterY = rowTop + rowHeight * 0.5
      if (index > 0) {
        ctx.strokeStyle = 'rgb(255 255 255 / 0.06)'
        ctx.beginPath()
        ctx.moveTo(textX, rowTop + 0.5)
        ctx.lineTo(cardX + cardWidth - INFO_CARD_PADDING, rowTop + 0.5)
        ctx.stroke()
      }
      ctx.font = `600 11px ${FONT_FAMILY}`
      ctx.fillStyle = toCssColorAlpha(target.body.accent, 0.72)
      ctx.fillText(row.label, textX, rowCenterY)
      ctx.font = INFO_FONT
      ctx.fillStyle = '#e2e6eb'
      ctx.fillText(row.value, dividerX + 10, rowCenterY)
    }
    ctx.textBaseline = 'alphabetic'
    ctx.globalAlpha = 1
  }
  ctx.restore()

  if (briefReveal > 0) {
    drawBodyMeasurementGuide(target, guideOnRight, briefReveal)
  }
}

function drawMinimap(camera: CameraTransform): void {
  const { width, height } = syncMinimapCanvas()
  const padding = 14
  const centerX = width * 0.5
  const centerY = height * 0.5
  const maxOrbitRadius = Math.max(
    ...planetBodies.map(body => getOrbitDisplayRadius(body)),
  )
  const cameraPlane = worldToMinimapPlane(camera.position)
  const cameraOrbitRadius = Math.hypot(cameraPlane.x, cameraPlane.y)
  const viewRadius = Math.max(maxOrbitRadius + 80, cameraOrbitRadius * 1.12, 220)
  const scale = (Math.min(width, height) * 0.5 - padding) / viewRadius

  miniCtx.clearRect(0, 0, width, height)
  miniCtx.fillStyle = '#000'
  miniCtx.fillRect(0, 0, width, height)

  miniCtx.strokeStyle = 'rgb(255 255 255 / 0.06)'
  miniCtx.lineWidth = 1
  miniCtx.beginPath()
  miniCtx.moveTo(centerX, padding)
  miniCtx.lineTo(centerX, height - padding)
  miniCtx.moveTo(padding, centerY)
  miniCtx.lineTo(width - padding, centerY)
  miniCtx.stroke()

  miniCtx.strokeStyle = 'rgb(255 255 255 / 0.08)'
  for (let index = 0; index < planetBodies.length; index++) {
    const body = planetBodies[index]!
    const orbitRadius = getOrbitDisplayRadius(body)
    miniCtx.beginPath()
    miniCtx.arc(centerX, centerY, orbitRadius * scale, 0, Math.PI * 2)
    miniCtx.stroke()
  }

  miniCtx.fillStyle = toCssColor(celestialBodies[0]!.accent)
  miniCtx.beginPath()
  miniCtx.arc(centerX, centerY, 4, 0, Math.PI * 2)
  miniCtx.fill()

  for (let index = 0; index < planetBodies.length; index++) {
    const body = planetBodies[index]!
    const point = worldToMinimapPlane(body.center)
    const x = centerX + point.x * scale
    const y = centerY - point.y * scale
    miniCtx.fillStyle = toCssColor(body.accent)
    miniCtx.beginPath()
    miniCtx.arc(x, y, clamp(body.radius * 0.16, 2, 5), 0, Math.PI * 2)
    miniCtx.fill()
  }

  const cameraX = centerX + cameraPlane.x * scale
  const cameraY = centerY - cameraPlane.y * scale
  miniCtx.strokeStyle = 'rgb(120 210 255 / 0.95)'
  miniCtx.fillStyle = 'rgb(120 210 255 / 0.95)'
  miniCtx.beginPath()
  miniCtx.arc(cameraX, cameraY, 3, 0, Math.PI * 2)
  miniCtx.fill()

  const forwardPlane = {
    x: dotVec3(camera.forward, SOLAR_LATERAL_AXIS),
    y: dotVec3(camera.forward, SOLAR_PRIMARY_AXIS),
  }
  const forwardLength = Math.hypot(forwardPlane.x, forwardPlane.y)
  if (forwardLength > 1e-4) {
    const lineLength = 16
    const dirX = forwardPlane.x / forwardLength
    const dirY = forwardPlane.y / forwardLength
    miniCtx.beginPath()
    miniCtx.moveTo(cameraX, cameraY)
    miniCtx.lineTo(cameraX + dirX * lineLength, cameraY - dirY * lineLength)
    miniCtx.stroke()
  }
}

function drawFrame(rows: RowRun[][], camera: CameraTransform): void {
  const metrics = state.metrics
  if (metrics === null) return

  const width = getCanvasCssWidth()
  const height = getCanvasCssHeight()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)

  ctx.font = metrics.font
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  let baselineY = metrics.top + metrics.baselineOffset
  for (let row = 0; row < rows.length; row++) {
    const rowRuns = rows[row]!
    for (let runIndex = 0; runIndex < rowRuns.length; runIndex++) {
      const run = rowRuns[runIndex]!
      ctx.fillStyle = run.color
      ctx.fillText(run.text, metrics.left + run.startCol * metrics.cellWidth, baselineY)
    }
    baselineY += metrics.lineHeight
  }

  if (state.flightStarted) {
    drawPlanetGuides(camera)
    if (state.briefOpenBodyId === null) {
      drawBodyOverlay(camera)
    }
    drawFloatingPanelGuides(camera)
  }
  drawMinimap(camera)
}

function axisFromKeys(positive: string, negative: string): number {
  return (pressedKeys.has(positive) ? 1 : 0) - (pressedKeys.has(negative) ? 1 : 0)
}

function resolveCameraCollisions(nextPosition: Vec3, previousPosition: Vec3): { position: Vec3, collided: boolean } {
  let resolved = nextPosition
  let collided = false

  for (let pass = 0; pass < 2; pass++) {
    let hadCollision = false
    for (let index = 0; index < celestialBodies.length; index++) {
      const body = celestialBodies[index]!
      const minDistance = body.radius + CAMERA_COLLISION_MARGIN
      const offset = subtractVec3(resolved, body.center)
      const distance = lengthVec3(offset)
      if (distance >= minDistance) continue

      let normal = distance > 1e-5
        ? scaleVec3(offset, 1 / distance)
        : normalizeVec3(subtractVec3(previousPosition, body.center))
      if (lengthVec3(normal) <= 1e-5) normal = WORLD_UP

      resolved = addVec3(body.center, scaleVec3(normal, minDistance))
      collided = true
      hadCollision = true
    }
    if (!hadCollision) break
  }

  return { position: resolved, collided }
}

function applyCameraInput(dt: number): void {
  const yawDelta = clamp(axisFromKeys('ArrowRight', 'ArrowLeft') + state.touchControls.lookX, -1, 1)
  const pitchDelta = clamp(axisFromKeys('ArrowUp', 'ArrowDown') + state.touchControls.lookY, -1, 1)
  if (yawDelta !== 0 || pitchDelta !== 0) {
    state.camera.yaw += yawDelta * KEY_LOOK_SPEED * dt
    state.camera.pitch = clamp(state.camera.pitch + pitchDelta * KEY_LOOK_SPEED * dt, -1.45, 1.45)
  }

  const camera = createCameraTransform(state.camera)
  const strafe = clamp(axisFromKeys('KeyD', 'KeyA') + state.touchControls.moveX, -1, 1)
  const lift = clamp(axisFromKeys('KeyE', 'KeyQ') + state.touchControls.lift, -1, 1)
  const thrust = clamp(axisFromKeys('KeyW', 'KeyS') + state.touchControls.moveY, -1, 1)
  const braking = pressedKeys.has('Space') || state.touchControls.braking
  if (braking) {
    state.camera.velocity = { x: 0, y: 0, z: 0 }
    return
  }

  let inputDirection = addVec3(
    addVec3(scaleVec3(camera.right, strafe), scaleVec3(WORLD_UP, lift)),
    scaleVec3(camera.forward, thrust),
  )
  const inputLength = lengthVec3(inputDirection)
  if (inputLength <= 0) {
    state.camera.velocity = { x: 0, y: 0, z: 0 }
    return
  }

  inputDirection = scaleVec3(inputDirection, 1 / inputLength)
  const boost = hasAnyPressed('ShiftLeft', 'ShiftRight') ? BOOST_MULTIPLIER : 1
  const moveSpeed = BASE_MOVE_SPEED * getSpeed() * boost
  const targetVelocity = scaleVec3(inputDirection, moveSpeed)
  const accelerationBlend = clamp01(1 - Math.exp(-dt * MOVE_ACCELERATION_RESPONSE))
  state.camera.velocity = lerpVec3(state.camera.velocity, targetVelocity, accelerationBlend)
  const nextPosition = addVec3(state.camera.position, scaleVec3(state.camera.velocity, dt))
  const collision = resolveCameraCollisions(nextPosition, state.camera.position)
  state.camera.position = collision.position
  if (collision.collided) state.camera.velocity = { x: 0, y: 0, z: 0 }
}

function applyPointerLook(movementX: number, movementY: number): void {
  if (!state.pointerLocked) return
  state.camera.yaw += movementX * LOOK_SENSITIVITY
  state.camera.pitch = clamp(state.camera.pitch - movementY * LOOK_SENSITIVITY, -1.45, 1.45)
}

function setPointerLockState(locked: boolean): void {
  state.pointerLocked = locked
  if (locked) {
    state.pointerLockNotice = 'pointer locked'
    state.pointerLockNoticeUntil = performance.now() + 1000
  } else {
    clearPressedKeys()
    clearTouchControls()
  }
  updateHud()
}

function renderFrame(timestamp: number): void {
  if (state.metrics === null || state.palette === null) syncCanvasMetrics()
  if (state.metrics === null || state.palette === null || mainCanvas === null || minimapCanvas === null) return

  let dt = 0
  if (state.lastTimestamp !== 0) {
    dt = Math.min(MAX_DT, (timestamp - state.lastTimestamp) / 1000)
  }
  state.lastTimestamp = timestamp

  updateSimulation(dt)
  const previousCamera = createCameraTransform(state.camera)
  applyCameraInput(dt)
  const currentCamera = createCameraTransform(state.camera)
  updateBodyOverlayState(dt, currentCamera)
  syncFloatingPanels(currentCamera)
  state.hudPanels = projectFloatingPanels(currentCamera)

  const rows = buildRows(previousCamera, currentCamera)
  drawFrame(rows, currentCamera)
  updateHud()
}

function initializeWorkerRuntime(message: WorkerInitMessage): void {
  mainCanvas = message.canvas
  minimapCanvas = message.minimap
  state.viewport = message.viewport

  const context = mainCanvas.getContext('2d')
  if (context === null) throw new Error('2D canvas context not available')
  ctx = context

  const minimapContext = minimapCanvas.getContext('2d')
  if (minimapContext === null) throw new Error('minimap context not available')
  miniCtx = minimapContext

  syncCanvasMetrics()
  state.lastTimestamp = 0
  state.orbitReferenceAngle = getOrbitReferenceAngle(state.simulationTimeMs)
  updateCelestialBodies(state.simulationTimeMs)
  updateMoonBodies(state.simulationTimeMs)
  state.camera.position = addVec3(earthBody.center, CAMERA_START_OFFSET_FROM_EARTH)
  state.camera.velocity = { x: 0, y: 0, z: 0 }
  clearFloatingPanels()
  syncSaturnRingParticles()
  syncStarCount()
  updateHud()
}

workerScope.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data

  switch (message.type) {
    case 'init':
      initializeWorkerRuntime(message)
      return
    case 'resize':
      state.viewport = message.viewport
      syncCanvasMetrics()
      return
    case 'frame':
      renderFrame(message.timestamp)
      return
    case 'flight-started':
      state.flightStarted = true
      state.briefPromptBodyId = null
      state.briefOpenBodyId = null
      state.briefReveal = 0
      return
    case 'keydown':
      if (message.code === 'Space' && !message.repeat && handleSpaceInteraction()) {
        updateHud()
        return
      }
      pressedKeys.add(message.code)
      return
    case 'keyup':
      pressedKeys.delete(message.code)
      return
    case 'pointer-move':
      applyPointerLook(message.movementX, message.movementY)
      return
    case 'pointer-lock':
      setPointerLockState(message.locked)
      return
    case 'pointer-lock-notice':
      state.pointerLockNotice = message.text
      state.pointerLockNoticeUntil = performance.now() + message.durationMs
      updateHud()
      return
    case 'touch-controls':
      state.touchControls.moveX = clamp(message.moveX, -1, 1)
      state.touchControls.moveY = clamp(message.moveY, -1, 1)
      state.touchControls.lookX = clamp(message.lookX, -1, 1)
      state.touchControls.lookY = clamp(message.lookY, -1, 1)
      state.touchControls.lift = clamp(message.lift, -1, 1)
      state.touchControls.braking = message.braking
      return
    case 'touch-activate':
      if (handleSpaceInteraction()) updateHud()
      return
    case 'open-answer-panel': {
      if (state.briefOpenBodyId === null || message.bodyId !== state.briefOpenBodyId) return
      const camera = createCameraTransform(state.camera)
      const slot = state.floatingAnswerPanels.length
      state.floatingAnswerPanels.push({
        id: message.id,
        kind: 'answer',
        bodyId: message.bodyId,
        anchor: createFloatingPanelAnchor(camera, slot + 1, 'answer'),
      })
      return
    }
    case 'close-answer-panel':
      state.floatingAnswerPanels = state.floatingAnswerPanels.filter(panel => panel.id !== message.id)
      return
    case 'clear-keys':
      clearPressedKeys()
      clearTouchControls()
      updateHud()
      return
  }
})
