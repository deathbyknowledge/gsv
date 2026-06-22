import { ConsoleHeader } from "../../app/components/ui/ConsoleHeader";
import { SectionHeader } from "../../app/components/ui/SectionHeader";
import { StatusDot } from "../../app/components/ui/StatusDot";
import type { StatusTone } from "../../app/components/ui/StatusDot";
import { Tag } from "../../app/components/ui/Tag";
import type { TagTone } from "../../app/components/ui/Tag";
import { Icon } from "../../app/components/ui/Icon";

/* ---------------------------------------------------------------------------
 * Seed data — transcribed from the GSV Live PAGE_DEFS object and the
 * settings-pa-full.png reference. Each category becomes a SectionHeader bar
 * followed by ListRows. No backend; this is a static, self-contained page.
 * ------------------------------------------------------------------------- */

interface Item {
  /** Dot-matrix icon name (file in web/public/icons/, no extension). */
  icon: string;
  label: string;
  /** Status tone used for the StatusDot. */
  tone: StatusTone;
  /** Short status word (ONLINE / IDLE / SYNCED / RUNNING / …); omit to use a tag. */
  statusLabel?: string;
  /** Optional boxed tag (e.g. UPDATE / DEFAULT) shown before the status. */
  tag?: { label: string; tone: TagTone };
}

interface Category {
  title: string;
  /** Count shown after the title, e.g. "2". */
  count: number;
  /** Small sub-meta word under the count, e.g. HOSTS / CHANNELS / LINKED. */
  noun: string;
  items: Item[];
}

const CATEGORIES: Category[] = [
  {
    title: "MACHINES",
    count: 2,
    noun: "HOSTS",
    items: [
      { icon: "computer", label: "<HANK-LINUX>", tone: "online", statusLabel: "ONLINE" },
      { icon: "computer", label: "<KAWAH-OILMACHINE>", tone: "idle", statusLabel: "IDLE" },
    ],
  },
  {
    title: "MESSENGERS",
    count: 2,
    noun: "CHANNELS",
    items: [
      { icon: "telegram", label: "Telegram", tone: "online", statusLabel: "ONLINE" },
      { icon: "discord", label: "Discord", tone: "online", statusLabel: "ONLINE" },
    ],
  },
  {
    title: "INTEGRATIONS",
    count: 2,
    noun: "LINKED",
    items: [
      { icon: "gmail", label: "Gmail", tone: "online", statusLabel: "SYNCED" },
      { icon: "list", label: "Linear", tone: "online", statusLabel: "SYNCED" },
    ],
  },
  {
    title: "APPLICATIONS",
    count: 2,
    noun: "APPS",
    items: [
      {
        icon: "weblink",
        label: "<CONTACT-LIST>",
        tone: "online",
        statusLabel: "HAM-INC",
        tag: { label: "UPDATE", tone: "update" },
      },
      { icon: "stars", label: "<SPACE-SIMULATION>", tone: "online", statusLabel: "ESTEVO" },
    ],
  },
  {
    title: "CREW",
    count: 3,
    noun: "AGENTS",
    items: [
      { icon: "chat", label: "XANADU", tone: "online", statusLabel: "ONLINE" },
      { icon: "chat", label: "LIGER", tone: "online", statusLabel: "ONLINE" },
      { icon: "chat", label: "BOB", tone: "idle", statusLabel: "IDLE" },
    ],
  },
  {
    title: "MODELS",
    count: 4,
    noun: "1 DEFAULT",
    items: [
      {
        icon: "cog",
        label: "Nemotron 3",
        tone: "online",
        statusLabel: "DEFAULT",
        tag: { label: "DEFAULT", tone: "accent" },
      },
      { icon: "cog", label: "Nemotron 2", tone: "idle", statusLabel: "LEGACY" },
      { icon: "cog", label: "Model 2", tone: "online", statusLabel: "READY" },
      { icon: "cog", label: "Model 3", tone: "online", statusLabel: "READY" },
    ],
  },
  {
    title: "TASKS",
    count: 35,
    noun: "23 RUNNING",
    items: [
      { icon: "list", label: "Polishing silverware", tone: "online", statusLabel: "RUNNING" },
      { icon: "list", label: "Indexing the library", tone: "online", statusLabel: "RUNNING" },
      { icon: "list", label: "Instagram events of the week", tone: "error", statusLabel: "ERROR" },
      { icon: "list", label: "Email vet", tone: "idle", statusLabel: "DONE" },
      { icon: "list", label: "Archiving old logs", tone: "idle", statusLabel: "IDLE" },
    ],
  },
];

/** Map a StatusDot tone to the ListRow status union (for the dot baked into
 *  ListRow we instead render our own dot + word in the row's status slot). */
const TONE_STATUS_TEXT: Record<StatusTone, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "#9a95cf",
  update: "var(--update)",
  live: "var(--live)",
  warn: "var(--warn)",
};

/** A single category: the SectionHeader bar (square dot + title + count meta +
 *  chevron) followed by its ListRows. */
function CategorySection({ cat }: { cat: Category }) {
  return (
    <div>
      {/* SectionHeader bar with a right-aligned chevron overlaid via a flex wrapper. */}
      <div style={{ position: "relative" }}>
        <SectionHeader title={cat.title} meta={`· ${cat.count}`} divider />
        <span
          style={{
            position: "absolute",
            right: "20px",
            top: "0",
            bottom: "0",
            display: "inline-flex",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          <svg width="9" height="12" viewBox="0 0 9 12" style={{ filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
            <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
          </svg>
        </span>
        {/* Small sub-meta word (HOSTS / CHANNELS / LINKED …), under the count. */}
        <span
          style={{
            position: "absolute",
            right: "44px",
            top: "50%",
            transform: "translateY(6px)",
            fontFamily: "var(--gsv-font-mono)",
            fontSize: "9px",
            letterSpacing: ".16em",
            color: "var(--text-dim)",
            pointerEvents: "none",
          }}
        >
          {cat.noun}
        </span>
      </div>

      {cat.items.map((it, i) => (
        <div
          key={i}
          class="ds-settings-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            padding: "15px 20px",
            borderBottom: "1px solid var(--border)",
            cursor: "pointer",
            transition: "background .12s",
            fontFamily: "var(--gsv-font-mono)",
          }}
        >
          <span style={{ display: "flex", flex: "none", color: "var(--accent-bright)" }}>
            <Icon name={it.icon} size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "12.5px", letterSpacing: ".04em", color: "var(--text)" }}>{it.label}</div>
          </div>
          {it.tag ? <Tag tone={it.tag.tone} label={it.tag.label} boxed /> : null}
          {it.statusLabel ? (
            <span
              style={{
                flex: "none",
                fontSize: "9px",
                letterSpacing: ".12em",
                color: TONE_STATUS_TEXT[it.tone],
              }}
            >
              {it.statusLabel}
            </span>
          ) : null}
          <StatusDot tone={it.tone} size={8} />
        </div>
      ))}
    </div>
  );
}

/** SettingsDashboard — the GSV "Settings Dashboard" ("The Ship") page. A console
 *  page on var(--void): a breadcrumb ConsoleHeader, then one raised panel holding
 *  every object category (MACHINES, MESSENGERS, INTEGRATIONS, APPLICATIONS, CREW,
 *  MODELS, TASKS) as a SectionHeader bar + ListRow-style rows. */
export function SettingsDashboard() {
  return (
    <div
      style={{
        minHeight: "100%",
        background: "var(--void)",
        fontFamily: "var(--gsv-font-mono)",
        color: "#cdd2e0",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ConsoleHeader
        crumbs={[{ label: "GSV", onClick: () => {} }, { label: "CONTROL" }]}
        tail="GSV // CONTROL"
      />

      <div style={{ flex: 1, padding: "20px" }}>
        <div
          style={{
            border: "1px solid var(--border-raised)",
            background: "var(--panel)",
            boxShadow: "inset 0 0 0 1px #060414, 0 0 30px rgba(80,70,180,.1)",
          }}
        >
          {CATEGORIES.map((cat) => (
            <CategorySection key={cat.title} cat={cat} />
          ))}
        </div>
      </div>
    </div>
  );
}
