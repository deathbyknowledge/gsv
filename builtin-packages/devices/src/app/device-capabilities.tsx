import type { DeviceDetail } from "./types";

type DeviceCapabilitiesProps = {
  device: DeviceDetail;
};

export function DeviceCapabilities({ device }: DeviceCapabilitiesProps) {
  const groups = groupCapabilities(device.implements);

  return (
    <section class="devices-detail-section">
      <div class="devices-capability-groups">
        {groups.map((group) => (
          <section key={group.name} class="devices-capability-group">
            <header>
              <h3>{group.name}</h3>
              <p>{group.items.length} capability{group.items.length === 1 ? "" : "ies"}</p>
            </header>
            <div class="devices-capability-list">
              {group.items.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function groupCapabilities(implementsList: string[]): Array<{ name: string; items: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const capability of implementsList) {
    const prefix = capability.split(".")[0] || "other";
    const name = prefix.toUpperCase();
    const bucket = buckets.get(name) ?? [];
    bucket.push(capability);
    buckets.set(name, bucket);
  }
  return [...buckets.entries()]
    .map(([name, items]) => ({ name, items: items.sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
