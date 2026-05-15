import type { SocialRoute, SocialSection, SocialState } from "../../types";
import { getAttentionCounts } from "../../domain/messageWorkflow";

const SECTIONS: Array<{
  id: SocialSection;
  label: string;
  group: string;
  countKey?: "active" | "channels" | "contacts" | "publishedRecords";
}> = [
  { id: "inbox", label: "Inbox", group: "Work", countKey: "active" },
  { id: "channels", label: "Channels", group: "Work", countKey: "channels" },
  { id: "contacts", label: "Contacts", group: "Trust", countKey: "contacts" },
  { id: "directory", label: "Directory", group: "Records", countKey: "publishedRecords" },
  { id: "advanced", label: "Advanced", group: "System" },
];

export function GlobalNavigation(props: {
  state: SocialState | null;
  route: SocialRoute;
  pending: boolean;
  onSelectSection: (section: SocialSection) => void;
}) {
  const counts = getAttentionCounts(props.state);
  const grouped = SECTIONS.reduce<Array<{ group: string; items: typeof SECTIONS }>>((groups, item) => {
    const last = groups[groups.length - 1];
    if (last?.group === item.group) {
      last.items.push(item);
    } else {
      groups.push({ group: item.group, items: [item] });
    }
    return groups;
  }, []);

  return (
    <nav class="social-global-nav" aria-label="Social sections">
      <header class="social-nav-identity">
        <p class="social-eyebrow">Social</p>
        <strong>{props.state?.identity?.profile?.displayName ?? props.state?.identity?.handle ?? "Not linked"}</strong>
        <span>{props.pending ? "Loading" : props.state?.identity?.handle ?? "Identity required"}</span>
      </header>
      <div class="social-nav-groups">
        {grouped.map((group) => (
          <section key={group.group} class="social-nav-group">
            <h2>{group.group}</h2>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                class={`social-nav-item${props.route.section === item.id ? " is-active" : ""}`}
                onClick={() => props.onSelectSection(item.id)}
              >
                <span>{item.label}</span>
                {item.countKey ? <strong>{counts[item.countKey]}</strong> : null}
              </button>
            ))}
          </section>
        ))}
      </div>
    </nav>
  );
}
