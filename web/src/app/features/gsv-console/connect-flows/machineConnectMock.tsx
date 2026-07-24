import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { CopyGlyph } from "../../../components/ui/lineGlyphs";
import { ListRow } from "../../../components/ui/ListRow";
import { Spinner } from "../../../components/ui/Spinner";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import { Tile } from "../../../components/ui/Tile";
import type { ConnectFlowDef } from "./connectFlowTypes";

// Static mock of the 5-step machine provisioning wizard. No state, no
// mutations — every action button simply advances the shell's stepper.
const PLATFORMS = [
  { id: "mac", label: "MAC", meta: "Apple desktop or laptop", command: "MACOS / ZSH", dotIcon: "apple" },
  { id: "windows", label: "WINDOWS", meta: "PowerShell target", command: "WINDOWS / POWERSHELL", dotIcon: "windows" },
  { id: "linux", label: "LINUX", meta: "Server or workstation", command: "LINUX / BASH", dotIcon: "redhat" },
] as const;

const SELECTED_PLATFORM = "mac";

const INSTALL_COMMAND =
  "curl -fsSL https://install.gsv.space | GSV_CHANNEL=dev bash";

const CONNECT_COMMAND = [
  'gsv config --local set gateway.url "wss://gsv.studio/ws"',
  'gsv config --local set gateway.username "jessicat"',
  'gsv config --local set node.token "a1b2c3d4e5f6g7h8"',
  'gsv device install --id "studio-macbook" --workspace ~/',
].join("\n");

/** Copy-able command block — header (title + meta + COPY) over a <pre> body. */
function CommandBlock({ title, meta, value }: { title: string; meta: string; value: string }) {
  return (
    <section class="gsv-cf-cmd">
      <header class="gsv-cf-cmd-head">
        <span class="gsv-cf-cmd-title gsv-sublabel">{title}</span>
        <span class="gsv-cf-cmd-meta gsv-sublabel">{meta}</span>
        <button type="button" class="gsv-cf-cmd-copy">
          <CopyGlyph size={12} />
          <span>COPY</span>
        </button>
      </header>
      <pre class="gsv-cf-cmd-body">{value}</pre>
    </section>
  );
}

export const machineConnectFlow: ConnectFlowDef = {
  key: "machines",
  navLabel: "MACHINES",
  parentLabel: "MACHINES",
  icon: "computer",
  title: "Connect machine",
  blurb:
    "Provision a native device token, install the CLI, and attach the machine to the fleet · Mac, Windows, or Linux.",
  steps: [
    {
      key: "platform",
      label: "PLATFORM",
      title: "SELECT PLATFORM",
      meta: "STEP 1 / 5",
      status: "NOT DETECTED",
      tone: "idle",
      render: (nav) => (
        <>
          <p class="gsv-cf-desc gsv-prose" style={{ margin: 0 }}>
            Choose the operating system for the machine you are adding to the fleet.
          </p>
          <div class="gsv-cf-tiles">
            {PLATFORMS.map((option) => {
              const selected = option.id === SELECTED_PLATFORM;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected ? "true" : "false"}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "10px",
                    padding: "16px 12px",
                    border: 0,
                    background: "transparent",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  <Tile
                    label={option.label}
                    glyph="machines"
                    iconSrc={`/icons/doticons/${option.dotIcon}.svg`}
                    iconTitle={option.label}
                    iconSize={36}
                    status={selected ? "accent" : "idle"}
                    statusHint={`Select ${option.label}`}
                    selected={selected}
                  />
                  <span class="gsv-sublabel" style={{ letterSpacing: ".1em", color: "#8c86c8" }}>
                    {option.meta}
                  </span>
                  <Tag tone={selected ? "accent" : "idle"} label={option.command} boxed />
                </button>
              );
            })}
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK TO MACHINES" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="CONTINUE" onClick={nav.onNext} />
          </div>
        </>
      ),
    },
    {
      key: "details",
      label: "DETAILS",
      title: "DEVICE DETAILS",
      meta: "STEP 2 / 5",
      status: "DRAFT",
      tone: "idle",
      render: (nav) => (
        <>
          <div class="gsv-cf-fields">
            <TextInput
              label="MACHINE NAME"
              value="Studio MacBook"
              placeholder="Studio MacBook"
              status="success"
              message="Display label ready"
            />
            <TextInput
              label="DEVICE ID"
              value="studio-macbook"
              placeholder="studio-macbook"
              info="Used by CLI and routing"
            />
            <TextInput label="TOKEN EXPIRY" value="30" suffix="DAYS" />
          </div>
          <div class="gsv-cf-framed">
            <ListRow
              icon="computer"
              label="Studio MacBook"
              sub="studio-macbook / macOS / zsh"
              status="online"
              statusLabel="READY"
              statusDotPlacement="trailing"
            />
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="CONTINUE" onClick={nav.onNext} />
          </div>
        </>
      ),
    },
    {
      key: "install",
      label: "INSTALL",
      title: "INSTALL CLI",
      meta: "STEP 3 / 5",
      status: "REGISTERED",
      tone: "warn",
      render: (nav) => (
        <>
          <p class="gsv-cf-desc gsv-prose" style={{ margin: 0 }}>
            Run this installer on the machine you want GSV to control.
          </p>
          <CommandBlock title="INSTALL COMMAND" meta="macOS / zsh" value={INSTALL_COMMAND} />
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="CLI INSTALLED" onClick={nav.onNext} />
          </div>
        </>
      ),
    },
    {
      key: "connect",
      label: "CONNECT",
      title: "CONNECT MACHINE",
      meta: "STEP 4 / 5",
      status: "WAITING",
      tone: "warn",
      render: (nav) => (
        <>
          <p class="gsv-cf-desc gsv-prose" style={{ margin: 0 }}>
            Run this command on the machine after the CLI installer completes.
          </p>
          <CommandBlock
            title="CONNECT COMMAND"
            meta="studio-macbook / token a1b2…"
            value={CONNECT_COMMAND}
          />
          <div class="gsv-cf-cap">
            <Spinner size={18} />
            <div class="gsv-cf-cap-text">
              <span class="gsv-cf-cap-title gsv-paragraph">Waiting for device registration.</span>
              <span class="gsv-cf-cap-sub gsv-prose-sm">
                Leave this open — the machine appears the moment it checks in with the gateway.
              </span>
            </div>
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="CHECK CONNECTION" onClick={nav.onNext} />
          </div>
        </>
      ),
    },
    {
      key: "success",
      label: "SUCCESS",
      title: "CONNECTED",
      meta: "STEP 5 / 5",
      status: "ONLINE",
      tone: "online",
      render: (nav) => (
        <>
          <div class="gsv-cf-cap">
            <span class="gsv-cf-cap-mark">
              <Icon name="computer" size={26} />
            </span>
            <div class="gsv-cf-cap-text">
              <span class="gsv-cf-cap-title gsv-paragraph">Studio MacBook is connected</span>
              <span class="gsv-cf-cap-sub gsv-prose-sm">
                The machine is now part of the GSV fleet and can be used by Files, Terminal, and agent tools.
              </span>
            </div>
          </div>
          <div class="gsv-cf-framed">
            <ListRow
              icon="computer"
              label="Studio MacBook"
              sub="macOS / 1.4.0 / owner jessicat"
              status="online"
              statusLabel="ONLINE"
              statusDotPlacement="trailing"
            />
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK TO MACHINES" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="OPEN MACHINE" onClick={() => undefined} />
          </div>
        </>
      ),
    },
  ],
};
