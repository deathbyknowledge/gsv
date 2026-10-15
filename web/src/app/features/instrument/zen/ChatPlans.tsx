import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useResponsibilities } from "../shared/Responsibilities";
import { responsibilityGroups } from "../shared/responsibilityModel";

export function ChatPlans({ account, onOpen }: { account?: ConsoleAccount; onOpen: () => void }) {
  const { current, open } = useResponsibilities(account, { routines: false });
  const count = current.data?.pages[0]?.count ?? 0;
  const first = responsibilityGroups(open).roots[0];
  if (!account || !canConfigure(account, "r12y.list") || !count || !first) return null;
  const state = first.state === "active" ? "in progress" : first.state === "open" ? "next" : first.state;
  return <button type="button" class="zen-plans" onClick={onOpen} aria-label={`Open plans · ${count} ongoing`}>
    <span class="zen-plans-count">{count} ongoing</span>
    <span class="zen-plans-preview"><span>{state} · </span>{first.title}</span>
    <span aria-hidden="true">›</span>
  </button>;
}
