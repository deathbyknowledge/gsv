import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import { ConsolePage } from "../components/ConsolePageTemplate";
import { ConnectFlowShell } from "./ConnectFlowShell";
import type { ConnectFlowDef } from "./connectFlowTypes";
import { machineConnectFlow } from "./machineConnectMock";
import { messengerConnectFlow } from "./messengerConnectMock";
import { integrationConnectFlow } from "./integrationConnectMock";
import { applicationConnectFlow } from "./applicationConnectMock";
import "../list-template/ListTemplateMockPage.css";
import "./ConnectFlowsMockPage.css";

const FLOWS: readonly ConnectFlowDef[] = [
  machineConnectFlow,
  messengerConnectFlow,
  integrationConnectFlow,
  applicationConnectFlow,
];

/** Standalone mock of the CONNECT-NEW flows — reachable at /connect-flows with
 *  the full shell chrome (rail + chat). Pick a flow, walk every step with mock
 *  data, to review the redesigned connect UX before applying it to the real
 *  Machines / Messenger / Integrations / Applications pages. */
export function ConnectFlowsMockPage(_props: { onOpenChat?: () => void }) {
  const [flowIndex, setFlowIndex] = useState(0);
  const [step, setStep] = useState(0);

  const flow = FLOWS[flowIndex];
  const clampedStep = Math.min(step, flow.steps.length - 1);

  const pickFlow = (index: number) => {
    setFlowIndex(index);
    setStep(0);
  };

  return (
    <ConsolePage flush>
      <div class="gsv-list-mock-controls" role="group" aria-label="Mock controls">
        <span class="gsv-list-mock-tag">MOCK</span>
        <Segmented
          size="small"
          l0={FLOWS[0].navLabel}
          l1={FLOWS[1].navLabel}
          l2={FLOWS[2].navLabel}
          l3={FLOWS[3].navLabel}
          value={flowIndex}
          onChange={pickFlow}
        />
        <span class="gsv-cf-mock-stepnav">
          <Button
            variant="secondary"
            label="◀ PREV STEP"
            disabled={clampedStep === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          />
          <span class="gsv-cf-mock-stepcount">
            STEP {clampedStep + 1} / {flow.steps.length}
          </span>
          <Button
            variant="secondary"
            label="NEXT STEP ▶"
            disabled={clampedStep === flow.steps.length - 1}
            onClick={() => setStep((s) => Math.min(flow.steps.length - 1, s + 1))}
          />
        </span>
      </div>

      <ConnectFlowShell flow={flow} current={clampedStep} onStep={setStep} />
    </ConsolePage>
  );
}
