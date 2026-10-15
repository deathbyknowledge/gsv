import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useResponsibilities } from "../shared/Responsibilities";

export function ChatPlans({ account, onOpen }: { account?: ConsoleAccount; onOpen: () => void }) {
  const { current } = useResponsibilities(account, { routines: false });
  const count = current.data?.pages[0]?.count ?? 0;
  if (!account || (!canConfigure(account, "r12y.list") && !canConfigure(account, "sched.list"))) return null;
  const visibleCount = canConfigure(account, "r12y.list") ? count : 0;
  return <button type="button" class="zen-plans" onClick={onOpen} aria-label={`Open plans · ${visibleCount} ongoing`}>
    <span class="zen-plans-count">{visibleCount ? `${visibleCount} ongoing` : "plans"}</span>
  </button>;
}
