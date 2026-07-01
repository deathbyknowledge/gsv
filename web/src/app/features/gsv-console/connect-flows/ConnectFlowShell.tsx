import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Stepper } from "../../../components/ui/Stepper";
import type { ConnectFlowDef, ConnectNav } from "./connectFlowTypes";
import "./ConnectFlowShell.css";

/** Split the action-bar blurb on the LAST " · " so the trailing clause drops to
 *  a second line (matches ConsoleDetailPage's two-line description). */
function splitBlurb(blurb: string): [string, string | null] {
  const idx = blurb.lastIndexOf(" · ");
  if (idx === -1) return [blurb, null];
  return [blurb.slice(0, idx), blurb.slice(idx + 3)];
}

export interface ConnectFlowShellProps {
  flow: ConnectFlowDef;
  current: number;
  onStep: (index: number) => void;
}

/** ConnectFlowShell — the simplified connect-new page chrome, shared by all four
 *  flows. Row 1+2: breadcrumb + SectionHeader (page title + status). Row 3: the
 *  action bar (icon tile + 2-line description + Stepper). Then the current
 *  step's body. */
export function ConnectFlowShell({ flow, current, onStep }: ConnectFlowShellProps) {
  const lastIndex = flow.steps.length - 1;
  const clamped = Math.max(0, Math.min(current, lastIndex));
  const step = flow.steps[clamped];
  const labels = flow.steps.map((s) => s.label);
  const [descPrimary, descSecondary] = splitBlurb(flow.blurb);

  const nav: ConnectNav = {
    onBack: () => onStep(Math.max(0, clamped - 1)),
    onNext: () => onStep(Math.min(lastIndex, clamped + 1)),
    goTo: (i) => onStep(Math.max(0, Math.min(lastIndex, i))),
    isFirst: clamped === 0,
    isLast: clamped === lastIndex,
  };

  return (
    <div class="gsv-cf">
      {/* Page header — title + status. The breadcrumb trail is supplied by the
          shell's top bar (ConsoleHeader), not duplicated here. */}
      <SectionHeader divider title={flow.title} meta={step.status} headingLevel={2} />

      {/* Action bar — icon tile + 2-line description, with the stepper below. */}
      <div class="gsv-cf-bar">
        <div class="gsv-cf-bar-lead">
          <span class="gsv-cf-icon">
            <Icon name={flow.icon} size={30} />
          </span>
          <p class="gsv-cf-desc gsv-prose">
            {descPrimary}
            {descSecondary ? (
              <>
                <br />
                {descSecondary}
              </>
            ) : null}
          </p>
        </div>
        <div class="gsv-cf-bar-actions">
          <Stepper
            size="small"
            width={Math.min(640, Math.max(280, 148 * labels.length))}
            current={clamped}
            onChange={onStep}
            l0={labels[0]}
            l1={labels[1]}
            l2={labels[2]}
            l3={labels[3]}
            l4={labels[4]}
          />
        </div>
      </div>

      {/* Body — current step. Left-aligned desktop-yellow title, description
          (rendered by the step body) below it; no nested section header. */}
      <div class="gsv-cf-body">
        <div class="gsv-cf-step">
          <h3 class="gsv-cf-step-title gsv-section">{step.title}</h3>
          {step.render(nav)}
        </div>
      </div>
    </div>
  );
}
