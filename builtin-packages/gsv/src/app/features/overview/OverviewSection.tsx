import { ActionButton } from "../../components/ui/ActionButton";
import { Icon, type IconName } from "../../components/ui/Icon";
import type { GsvBackend } from "../../backend-contract";
import type { GsvSectionId } from "../../navigation/types";
import type { PackagesView } from "../packages/types";
import { useOverview } from "./useOverview";
import type { OverviewAttentionItem } from "./overview-domain";

export function OverviewSection({
  backend,
  onNavigate,
  onOpenPackage,
}: {
  backend: GsvBackend;
  onNavigate: (sectionId: GsvSectionId) => void;
  onOpenPackage: (packageId: string, view?: PackagesView) => void;
}) {
  const overview = useOverview(backend);

  return (
    <section class="gsv-overview">
      <header class="gsv-overview-header">
        <div>
          <span class="gsv-kicker">Attention inbox</span>
          <h3>Operator-relevant issues across the running system.</h3>
        </div>
        <ActionButton
          icon="refresh"
          label="Refresh"
          busyLabel="Refreshing"
          busy={overview.loading}
          onClick={() => void overview.refresh()}
        />
      </header>

      {overview.model ? (
        <div class="gsv-overview-posture-strip" aria-label="System posture">
          {overview.model.posture.map((item) => (
            <button
              class={`gsv-overview-posture-item is-${item.tone}`}
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.sectionId)}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>
      ) : null}

      {overview.errorText ? <p class="gsv-inline-error">{overview.errorText}</p> : null}

      <div class="gsv-attention-list" aria-label="Live attention items" aria-busy={overview.loading ? "true" : "false"}>
        {!overview.model ? (
          <div class="gsv-empty-state">
            <h3>Loading overview</h3>
            <p>Checking runtime, fleet, extensions, integrations, and access state...</p>
          </div>
        ) : overview.model.attention.length === 0 ? (
          <div class="gsv-empty-state">
            <h3>No attention items</h3>
            <p>Runtime, fleet, extensions, integrations, and access posture are clear.</p>
          </div>
        ) : (
          overview.model.attention.map((item) => (
            <AttentionRow
              item={item}
              key={item.id}
              onOpen={() => openAttentionItem(item, onNavigate, onOpenPackage)}
            />
          ))
        )}
      </div>

      {overview.model ? (
        <p class="gsv-overview-updated">
          Updated {new Date(overview.model.loadedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </section>
  );
}

function AttentionRow({
  item,
  onOpen,
}: {
  item: OverviewAttentionItem;
  onOpen: () => void;
}) {
  return (
    <button class={`gsv-attention-row is-${item.tone}`} type="button" onClick={onOpen}>
      <span class={`gsv-overview-row-icon is-${item.tone}`}>
        <Icon name={sectionIcon(item.sectionId)} />
      </span>
      <span class="gsv-row-copy">
        <strong>{item.title}</strong>
        <span>{item.description}</span>
      </span>
      <span class="gsv-overview-row-meta">
        <span class={`gsv-mark is-${item.tone}`} aria-hidden="true"></span>
        <span>{item.meta}</span>
      </span>
      <Icon name="chevron-right" className="gsv-overview-row-chevron" />
    </button>
  );
}

function openAttentionItem(
  item: OverviewAttentionItem,
  onNavigate: (sectionId: GsvSectionId) => void,
  onOpenPackage: (packageId: string, view?: PackagesView) => void,
): void {
  if (item.packageId) {
    onOpenPackage(item.packageId, item.packageView);
    return;
  }
  onNavigate(item.sectionId);
}

function sectionIcon(sectionId: GsvSectionId): IconName {
  if (sectionId === "runtime") return "activity";
  if (sectionId === "devices") return "device";
  if (sectionId === "packages") return "package";
  if (sectionId === "integrations") return "plug";
  if (sectionId === "access") return "key";
  if (sectionId === "settings") return "settings";
  if (sectionId === "sources") return "code";
  return "home";
}
