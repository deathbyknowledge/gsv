import type { ComponentChildren } from "preact";
import type { StatusTone } from "../../../components/ui/StatusDot";

/** Navigation handed to each step body so its footer buttons can drive the mock
 *  wizard (advance / go back / jump). In the real flows these are wired to the
 *  actual mutations; in the mock they just move the stepper. */
export interface ConnectNav {
  onBack: () => void;
  onNext: () => void;
  goTo: (index: number) => void;
  isFirst: boolean;
  isLast: boolean;
}

/** One step of a connect-new wizard. */
export interface ConnectStepDef {
  /** Stable key. */
  key: string;
  /** Stepper label — short, uppercase (e.g. "PLATFORM"). */
  label: string;
  /** Body title shown in the per-step SectionHeader (e.g. "SELECT PLATFORM"). */
  title: string;
  /** Body eyebrow (e.g. "STEP 1 / 5"). */
  meta: string;
  /** Header status string for this step (e.g. "NOT DETECTED"). */
  status: string;
  /** Tone for the header status. */
  tone?: StatusTone;
  /** Renders the step body. `nav` advances the mock wizard. */
  render: (nav: ConnectNav) => ComponentChildren;
}

/** A full connect-new flow: page chrome + ordered steps. */
export interface ConnectFlowDef {
  /** Stable key (e.g. "machines"). */
  key: string;
  /** Flow-picker label (e.g. "MACHINES"). */
  navLabel: string;
  /** Breadcrumb parent (e.g. "MACHINES"). */
  parentLabel: string;
  /** Icon name for the action-bar tile. */
  icon: string;
  /** Page title (e.g. "Connect machine"). */
  title: string;
  /** Action-bar description. Split on the last " · " into two lines. */
  blurb: string;
  /** Ordered wizard steps (2–5). */
  steps: ConnectStepDef[];
}
