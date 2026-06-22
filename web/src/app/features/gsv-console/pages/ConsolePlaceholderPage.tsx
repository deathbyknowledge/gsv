import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot } from "../../../components/ui/StatusDot";
import { shellSurfaceLabel, type ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import { ConsolePage } from "../components/ConsolePageTemplate";

type ConsolePlaceholderPageProps = {
  surface: Exclude<ShellSurfaceId, "desktop">;
};

const ICON_FOR_SURFACE: Record<Exclude<ShellSurfaceId, "desktop">, string> = {
  settings: "cog",
  crew: "chat",
  agent: "chat",
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
  applications: "stars",
  object: "gmail",
  runtime: "list",
  files: "folder",
  library: "pencil",
  terminal: "terminal",
};

export function ConsolePlaceholderPage({ surface }: ConsolePlaceholderPageProps) {
  const label = shellSurfaceLabel(surface);

  return (
    <ConsolePage>
      <section class="gsv-console-section">
        <SectionHeader title={`${label} DETAIL`} meta="PENDING" divider />
        <div class="gsv-placeholder-body">
          <span class="gsv-placeholder-icon">
            <Icon name={ICON_FOR_SURFACE[surface]} size={42} />
          </span>
          <div>
            <h2>{label}</h2>
            <span>
              <StatusDot tone="idle" size={7} />
              DETAIL DATA NOT AVAILABLE
            </span>
          </div>
        </div>
      </section>
    </ConsolePage>
  );
}
