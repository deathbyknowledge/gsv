import { Icon } from "../../../components/ui/Icon";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import "./ConsoleDetailPage.css";

export type ConsoleDetailHeaderProps = {
  icon: string;
  title: string;
  typeLabel: string;
  statusLabel: string;
  tone: StatusTone;
};

/** The standard console object-detail header: framed icon + title + a
 *  type-label / status row. Shared by ConsoleDetailPage and the messenger
 *  connect flow so they read as the same family. */
export function ConsoleDetailHeader({ icon, title, typeLabel, statusLabel, tone }: ConsoleDetailHeaderProps) {
  return (
    <header class="gsv-console-detail-head">
      <span class="gsv-console-detail-icon">
        <Icon name={icon} size={30} />
      </span>
      <div class="gsv-console-detail-title">
        <h2>{title}</h2>
        <div>
          <span>{typeLabel}</span>
          <StatusDot tone={tone} size={7} />
          <span>{statusLabel}</span>
        </div>
      </div>
    </header>
  );
}
