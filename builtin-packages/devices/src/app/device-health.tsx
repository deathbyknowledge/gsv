import type { DeviceDetail } from "./types";

type DeviceHealthProps = {
  device: DeviceDetail;
};

export function DeviceHealth({ device }: DeviceHealthProps) {
  const lastSeenAge = Date.now() - device.lastSeenAt;
  const summary = device.online
    ? "Connected and available for routing."
    : lastSeenAge < 10 * 60_000
      ? "Recently disconnected. Reconnect likely in progress or the device was closed."
      : "Offline. Token or agent intervention may be needed before routing work here.";

  return (
    <section class="devices-detail-section">
      <div class="devices-health-banner">
        <strong>{device.online ? "Ready" : "Needs attention"}</strong>
        <span>{summary}</span>
      </div>
      <div class="devices-detail-table-wrap">
        <table class="devices-detail-table">
          <tbody>
            <tr>
              <th>Last heartbeat</th>
              <td>{formatTimestamp(device.lastSeenAt)}</td>
            </tr>
            <tr>
              <th>Connected at</th>
              <td>{formatNullableTimestamp(device.connectedAt)}</td>
            </tr>
            <tr>
              <th>Disconnected at</th>
              <td>{formatNullableTimestamp(device.disconnectedAt)}</td>
            </tr>
            <tr>
              <th>Capabilities advertised</th>
              <td>{device.implements.length}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatNullableTimestamp(timestamp: number | null): string {
  return typeof timestamp === "number" ? formatTimestamp(timestamp) : "—";
}
