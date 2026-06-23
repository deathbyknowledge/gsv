import { useMemo, useState } from "preact/hooks";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Surface } from "../../../components/ui/Surface";
import { TextInput } from "../../../components/ui/TextInput";
import type { FilesTarget } from "../domain/models";
import { describeTarget } from "../domain/view";
import { targetDisplayName, targetTone } from "../domain/workspace";

type FilesTargetRailProps = {
  activeTargetId: string | null;
  targets: readonly FilesTarget[];
  onOpenTarget: (targetId: string) => void;
};

function visibleTargets(targets: readonly FilesTarget[], activeTargetId: string | null): FilesTarget[] {
  const primary = targets.slice(0, 3);
  if (!activeTargetId || primary.some((target) => target.id === activeTargetId)) {
    return primary;
  }
  const activeTarget = targets.find((target) => target.id === activeTargetId);
  if (!activeTarget) {
    return primary;
  }
  return [...primary.slice(0, 2), activeTarget];
}

export function FilesTargetRail({ activeTargetId, targets, onOpenTarget }: FilesTargetRailProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = visibleTargets(targets, activeTargetId);
  const hiddenCount = Math.max(0, targets.length - visible.length);
  const filteredTargets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return targets;
    }
    return targets.filter((target) => [
      target.id,
      target.label,
      target.platform,
      target.description,
      target.ownerUsername ?? "",
    ].join(" ").toLowerCase().includes(needle));
  }, [query, targets]);

  return (
    <aside class="files-target-rail" aria-label="File targets">
      <div class="files-target-stack">
        {visible.map((target) => {
          const active = target.id === activeTargetId;
          return (
            <Surface
              as="button"
              class={`files-target-tile${active ? " is-active" : ""}`}
              flush
              interactive
              key={target.id}
              onClick={() => onOpenTarget(target.id)}
            >
              <span class="files-target-tile-icon">
                <Icon name={target.id === "gsv" ? "stars" : "computer"} size={22} />
              </span>
              <span class="files-target-tile-label">{targetDisplayName(target, target.id)}</span>
              <StatusDot tone={targetTone(target)} size={8} />
            </Surface>
          );
        })}
        {hiddenCount > 0 ? (
          <Surface
            as="button"
            class={`files-target-tile files-target-overflow${overflowOpen ? " is-active" : ""}`}
            flush
            interactive
            onClick={() => setOverflowOpen((open) => !open)}
          >
            <span class="files-target-dots">...</span>
            <span class="files-target-tile-label">{hiddenCount} MORE</span>
          </Surface>
        ) : null}
      </div>

      {overflowOpen ? (
        <div class="files-target-popover">
          <SectionHeader title="ALL MACHINES" meta={`${targets.length}`} divider />
          <div class="files-target-search">
            <TextInput
              label=""
              placeholder="Search targets"
              value={query}
              clearable
              onChange={setQuery}
            />
          </div>
          <div class="files-target-popover-list">
            {filteredTargets.map((target) => (
              <ListRow
                key={target.id}
                active={target.id === activeTargetId}
                label={targetDisplayName(target, target.id)}
                sub={describeTarget(target)}
                status={targetTone(target)}
                statusLabel={target.online ? "ONLINE" : "OFFLINE"}
                icon={target.id === "gsv" ? "stars" : "computer"}
                chevron
                onClick={() => {
                  onOpenTarget(target.id);
                  setOverflowOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
