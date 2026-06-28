import type { VNode } from "preact";
import { useMemo, useState } from "preact/hooks";
import { AgentCard } from "../../../components/ui/AgentCard";
import { Segmented } from "../../../components/ui/Segmented";
import { Select } from "../../../components/ui/Select";
import { Surface } from "../../../components/ui/Surface";
import { Toggle } from "../../../components/ui/Toggle";
import { ConsolePage } from "../components/ConsolePageTemplate";
import type { ConsoleAdapter } from "../domain/consoleModels";
import { agentImageSrcForIndex } from "../domain/agentPresentation";
import { MessengerCard } from "../messengers/MessengersPage";
import { CardListTemplate } from "./CardListTemplate";
import "../list-template/ListTemplateMockPage.css";

const FILTER_OPTIONS = ["ALL", "ONLINE", "IDLE"];

type MockCrew = { name: string; role: string; status: "online" | "idle" | "live"; tasks: number };

const MOCK_CREW: readonly MockCrew[] = [
  { name: "ARIA", role: "Operator", status: "online", tasks: 3 },
  { name: "ORSO", role: "Researcher", status: "live", tasks: 1 },
  { name: "VESPER", role: "Scheduler", status: "idle", tasks: 0 },
  { name: "KESTREL", role: "Analyst", status: "online", tasks: 2 },
];

function mockAdapter(adapter: string, accounts: number): ConsoleAdapter {
  return {
    adapter,
    available: true,
    supportsConnect: true,
    supportsDisconnect: true,
    supportsSend: true,
    supportsStatus: true,
    supportsShellExec: false,
    supportsActivity: true,
    accounts: Array.from({ length: accounts }, (_, i) => ({
      adapter,
      accountId: `${adapter}-${i}`,
      connected: true,
      authenticated: true,
      mode: "bot",
      lastActivity: null,
      error: "",
      extra: {},
    })),
  };
}

const MOCK_ADAPTERS: readonly ConsoleAdapter[] = [
  mockAdapter("telegram", 2),
  mockAdapter("discord", 0),
];

/** Standalone mock of the CARD list template — reachable at /card-template with
 *  the full shell chrome. Reuses the real AgentCard (crew) and MessengerCard
 *  (messengers) to review the grid before applying the template to the pages. */
export function CardListTemplateMockPage({ onOpenChat }: { onOpenChat?: () => void }) {
  const [surfaceIndex, setSurfaceIndex] = useState(0);
  const [populated, setPopulated] = useState(true);
  const [search, setSearch] = useState("");
  const [filterIndex, setFilterIndex] = useState(0);
  const [showSearch, setShowSearch] = useState(true);
  const [showFilter, setShowFilter] = useState(true);

  const isCrew = surfaceIndex === 0;
  const query = search.trim().toLowerCase();

  const cards = useMemo<VNode[]>(() => {
    if (!populated) {
      return [];
    }
    if (isCrew) {
      return MOCK_CREW
        .filter((agent) => !query || agent.name.toLowerCase().includes(query))
        .map((agent, index) => (
          <Surface key={agent.name} level={1} class="gsv-card-cell">
            <AgentCard
              agentName={agent.name}
              agentRole={agent.role}
              status={agent.status}
              imgSrc={agentImageSrcForIndex(index)}
              tasksTotal={agent.tasks}
              models={["claude-opus-4-8"]}
            />
          </Surface>
        ));
    }
    return MOCK_ADAPTERS
      .filter((adapter) => !query || adapter.adapter.toLowerCase().includes(query))
      .map((adapter) => (
        <MessengerCard
          key={adapter.adapter}
          adapter={adapter}
          identityLinks={[]}
          onConnect={() => undefined}
          onOpenDetail={() => undefined}
          onOpenPlatform={() => undefined}
        />
      ));
  }, [isCrew, populated, query]);

  const listTitle = isCrew ? "CREW" : "MESSENGERS";
  const totalCount = isCrew ? MOCK_CREW.length : MOCK_ADAPTERS.length;
  const listMeta = `${cards.length}/${totalCount} ${isCrew ? "CREW" : "SERVICES"}`;

  return (
    <ConsolePage flush>
      <div class="gsv-list-mock-controls" role="group" aria-label="Mock controls">
        <span class="gsv-list-mock-tag">MOCK</span>
        <Segmented
          size="small"
          l0="CREW"
          l1="MESSENGERS"
          l2=""
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

      <CardListTemplate
        listTitle={listTitle}
        listMeta={listMeta}
        emptyObject={listTitle}
        isEmpty={cards.length === 0}
        connectLabel={isCrew ? "NEW AGENT" : "CONNECT MESSENGER"}
        onConnect={onOpenChat}
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
      >
        {cards}
      </CardListTemplate>
    </ConsolePage>
  );
}
