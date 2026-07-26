import { useMemo, useState } from "preact/hooks";
import { Segmented } from "../../../components/ui/Segmented";
import { Select } from "../../../components/ui/Select";
import { Toggle } from "../../../components/ui/Toggle";
import {
  ConsolePage,
} from "../components/ConsolePageTemplate";
import { ListTemplate, type ListTemplateRow } from "./ListTemplate";
import "./ListTemplateMockPage.css";

type MockConnect =
  | { kind: "section"; section: "machines" | "integrations" }
  | { kind: "chat" };

type MockSurface = {
  key: string;
  listTitle: string;
  emptyObject: string;
  connectLabel: string;
  connect: MockConnect;
  state: string;
  rows: readonly ListTemplateRow[];
};

const MOCK_SURFACES: readonly MockSurface[] = [
  {
    key: "machines",
    listTitle: "MACHINES",
    emptyObject: "MACHINES",
    connectLabel: "+ CONNECT NEW MACHINE",
    connect: { kind: "section", section: "machines" },
    state: "ONLINE",
    rows: [
      { id: "m1", icon: "computer", label: "rearden-prime", sub: "linux · v0.80.2 · root", tone: "online", statusLabel: "ONLINE" },
      { id: "m2", icon: "computer", label: "node-galt", sub: "darwin · v0.80.2 · jessica", tone: "online", statusLabel: "ONLINE" },
      { id: "m3", icon: "computer", label: "edge-taggart", sub: "linux · v0.74.0 · ops", tone: "idle", statusLabel: "OFFLINE" },
    ],
  },
  {
    key: "integrations",
    listTitle: "INTEGRATIONS",
    emptyObject: "INTEGRATIONS",
    connectLabel: "+ CONNECT NEW INTEGRATION",
    connect: { kind: "section", section: "integrations" },
    state: "READY",
    rows: [
      { id: "i1", icon: "weblink", label: "github", sub: "12 tools · 4 resources", tone: "online", statusLabel: "READY" },
      { id: "i2", icon: "weblink", label: "linear", sub: "authenticating…", tone: "warn", statusLabel: "CHECK", tag: { label: "SIGN-IN", tone: "warn" } },
      { id: "i3", icon: "weblink", label: "sentry", sub: "connection refused", tone: "error", statusLabel: "ERROR" },
    ],
  },
  {
    key: "tasks",
    listTitle: "TASKS",
    emptyObject: "TASKS",
    connectLabel: "+ NEW TASK",
    connect: { kind: "chat" },
    state: "ACTIVE",
    rows: [
      { id: "t1", icon: "chat", label: "nightly-digest", sub: "jessica · ~/repos/gsv", tone: "live", statusLabel: "RUNNING" },
      { id: "t2", icon: "list", label: "index-rebuild", sub: "ops · ~/data", tone: "update", statusLabel: "QUEUED" },
      { id: "t3", icon: "list", label: "backup-sweep", sub: "root · /var", tone: "idle", statusLabel: "IDLE" },
    ],
  },
];

const FILTER_OPTIONS = ["ALL", "ONLINE", "OFFLINE"];

/** Standalone mock of the LIST page template — reachable at /list-template with
 *  the full shell chrome (rail + chat). Lets the template be reviewed in
 *  isolation before it is applied to the real pages. */
export function ListTemplateMockPage({
  onOpenSectionCreate,
  onOpenChat,
}: {
  onOpenSectionCreate?: (kind: "machines" | "integrations") => void;
  onOpenChat?: () => void;
}) {
  const [surfaceIndex, setSurfaceIndex] = useState(0);
  const [populated, setPopulated] = useState(true);
  const [search, setSearch] = useState("");
  const [filterIndex, setFilterIndex] = useState(0);
  const [showSearch, setShowSearch] = useState(true);
  const [showFilter, setShowFilter] = useState(true);

  const surface = MOCK_SURFACES[surfaceIndex];
  const visibleRows = useMemo(() => {
    if (!populated) {
      return [];
    }
    const query = search.trim().toLowerCase();
    const matched = query
      ? surface.rows.filter((row) => row.label.toLowerCase().includes(query))
      : surface.rows;
    // On real pages onOpen routes to the object detail / edit view; here it is a
    // no-op so rows stay hoverable + clickable for review.
    return matched.map((row) => ({ ...row, onOpen: () => undefined }));
  }, [surface, populated, search]);

  const listMeta = `${visibleRows.length}/${surface.rows.length} ${surface.state}`;
  const handleConnect = () => {
    if (surface.connect.kind === "chat") {
      onOpenChat?.();
    } else {
      onOpenSectionCreate?.(surface.connect.section);
    }
  };

  return (
    <ConsolePage flush>
      <div class="gsv-list-mock-controls" role="group" aria-label="Mock controls">
        <span class="gsv-list-mock-tag">MOCK</span>
        <Segmented
          size="small"
          l0="MACHINES"
          l1="INTEGRATIONS"
          l2="TASKS"
          value={surfaceIndex}
          onChange={setSurfaceIndex}
        />
        <Segmented
          size="small"
          l0="ITEMS"
          l1="EMPTY"
          l2=""
          value={populated ? 0 : 1}
          onChange={(index) => setPopulated(index === 0)}
        />
        <Toggle size="small" label="SEARCH" on={showSearch} onChange={setShowSearch} />
        <Toggle size="small" label="FILTER" on={showFilter} onChange={setShowFilter} />
      </div>

      <ListTemplate
        listTitle={surface.listTitle}
        listMeta={listMeta}
        rows={visibleRows}
        emptyObject={surface.emptyObject}
        connectLabel={surface.connectLabel}
        onConnect={handleConnect}
        search={showSearch ? { value: search, placeholder: "Search…", onChange: setSearch } : undefined}
        filters={showFilter ? (
          <Select
            block
            size="small"
            options={FILTER_OPTIONS}
            value={filterIndex}
            onChange={setFilterIndex}
          />
        ) : undefined}
      />
    </ConsolePage>
  );
}
