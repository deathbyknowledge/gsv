import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { ListRow } from "../../../components/ui/ListRow";
import { Select } from "../../../components/ui/Select";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConnectFlowDef } from "./connectFlowTypes";

// Static mock of the real 2-step "Add application" import → review → enable
// wizard (see packages/ApplicationImportFlow.tsx). No hooks/mutations — the
// footer buttons just drive the shared connect-flow stepper. Running example:
// a "Weather" web-ui package from team/weather.
export const applicationConnectFlow: ConnectFlowDef = {
  key: "applications",
  navLabel: "APPLICATIONS",
  parentLabel: "APPLICATIONS",
  icon: "satellite",
  title: "Add application",
  blurb:
    "Import a package from a public repo, review it, then enable it · git-clone, agent review, install.",
  steps: [
    {
      key: "import",
      label: "IMPORT",
      title: "IMPORT FROM REPO",
      meta: "STEP 1 / 2",
      status: "NOT IMPORTED",
      tone: "idle",
      render: (nav) => (
        <>
          <p class="gsv-cf-desc gsv-prose" style={{ maxWidth: "none" }}>
            Import a web UI package from a git source. The package is added
            disabled, then reviewed and enabled from the next step.
          </p>
          <div class="gsv-cf-fields">
            <TextInput
              label="PUBLIC REPOSITORY"
              value="https://github.com/team/weather.git"
              placeholder="https://github.com/team/package.git"
              info="Repo slug or remote URL"
              requirement="required"
              status="success"
              message="Source ready"
              clearable
            />
            <TextInput
              label="REF"
              value="main"
              placeholder="main"
              info="Branch, tag, or commit"
            />
            <TextInput
              label="SUBDIRECTORY"
              value="."
              placeholder="."
              info="Package root in the repo"
            />
          </div>
          <Checkbox
            checked
            label="INCLUDE AGENT REVIEW"
            status="success"
            message="Recommended before enabling"
          />
          <div style={{ maxWidth: "360px" }}>
            <Select
              label="REVIEWER"
              options={["research-agent / AGENT", "ops-agent / AGENT"]}
              value={0}
              block
              status="success"
              message="Review process will run as this agent"
            />
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="CANCEL" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="IMPORT APPLICATION" onClick={nav.onNext} />
          </div>
        </>
      ),
    },
    {
      key: "review",
      label: "REVIEW",
      title: "REVIEW & ENABLE",
      meta: "STEP 2 / 2",
      status: "REVIEW PENDING",
      tone: "update",
      render: (nav) => (
        <>
          <div class="gsv-cf-framed">
            <ListRow
              icon="box"
              label="Weather"
              sub="team/weather · web-ui · 3 entrypoints / 2 bindings"
              status="update"
              statusLabel="REVIEW"
              statusDotPlacement="trailing"
              tag="APPLICATION"
              tagTone="accent"
            />
          </div>
          <div class="gsv-cf-bar-actions" style={{ marginTop: "-6px" }}>
            <Tag tone="update" label="REVIEW PENDING" boxed />
            <Tag tone="online" label="PUBLIC SOURCE" boxed />
            <Tag tone="accent" label="WEB UI" boxed />
          </div>
          <div class="gsv-cf-cap">
            <span class="gsv-cf-cap-mark">
              <Tag tone="online" label="OK" />
            </span>
            <div class="gsv-cf-cap-text">
              <div class="gsv-cf-cap-title gsv-paragraph-small">AGENT REVIEW · research-agent</div>
              <div class="gsv-cf-cap-sub gsv-prose">
                Reviewed 14 files. No dangerous syscalls or network exfiltration
                found. Declares KV + FETCH bindings only, scoped to the package
                worker. No process spawning, shell execution, or eval. Verdict:
                safe to enable.
              </div>
            </div>
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="secondary" label="IMPORT WITHOUT ENABLING" />
            <Button variant="primary" label="APPROVE & ENABLE" />
          </div>
        </>
      ),
    },
  ],
};
