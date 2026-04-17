import type { DeviceDetail } from "./types";

type DeviceOverviewProps = {
  device: DeviceDetail;
};

export function DeviceOverview({ device }: DeviceOverviewProps) {
  const shellReady = device.implements.some((capability) => capability.startsWith("shell."));
  const fileReady = device.implements.some((capability) => capability.startsWith("fs."));

  return (
    <section class="devices-detail-section">
      <div class="devices-summary-grid">
        <Info label="Status" value={device.online ? "Ready" : "Offline"} />
        <Info label="Platform" value={device.platform || "Unknown"} />
        <Info label="Version" value={device.version || "Unknown"} />
        <Info label="Owner" value={`uid ${device.ownerUid}`} />
        <Info label="Shell" value={shellReady ? "Available" : "Unavailable"} />
        <Info label="Files" value={fileReady ? "Available" : "Unavailable"} />
      </div>

      <div class="devices-detail-table-wrap">
        <table class="devices-detail-table">
          <tbody>
            <Row label="Device id" value={device.deviceId} mono />
            <Row label="First seen" value={formatTimestamp(device.firstSeenAt)} />
            <Row label="Last seen" value={formatTimestamp(device.lastSeenAt)} />
            <Row label="Connected" value={formatNullableTimestamp(device.connectedAt)} />
            <Row label="Disconnected" value={formatNullableTimestamp(device.disconnectedAt)} />
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div class="devices-info-box">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <tr>
      <th>{label}</th>
      <td class={mono ? "is-mono" : undefined}>{value}</td>
    </tr>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatNullableTimestamp(timestamp: number | null): string {
  return typeof timestamp === "number" ? formatTimestamp(timestamp) : "—";
}
