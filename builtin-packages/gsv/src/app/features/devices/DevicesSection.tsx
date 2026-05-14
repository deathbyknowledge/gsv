import type { GsvBackend } from "../../backend-contract";
import { DeviceDetailPanel } from "./DeviceDetail";
import { DeviceFleetPane } from "./DeviceFleet";
import { ProvisionPanel } from "./DeviceProvision";
import { useDevices } from "./useDevices";

export function DevicesSection({ backend }: { backend: GsvBackend }) {
  const devices = useDevices(backend);
  const selected = devices.selectedDevice;
  const viewer = devices.state?.viewer ?? null;
  const showFleet = devices.mode === "detail" && !devices.selectedDeviceId;

  return (
    <section class={`gsv-devices${showFleet ? " is-fleet-view" : " is-detail-view"}`}>
      {showFleet ? (
        <DeviceFleetPane
          state={devices.state}
          visibleDevices={devices.visibleDevices}
          selectedDeviceId={devices.selectedDeviceId}
          query={devices.query}
          scope={devices.scope}
          errorText={devices.errorText}
          onAdd={() => {
            devices.setIssuedToken(null);
            devices.writeRoute({ mode: "provision" });
          }}
          onQuery={devices.setQuery}
          onScope={devices.setScope}
          onSelect={(deviceId) => {
            devices.setIssuedToken(null);
            devices.writeRoute({ mode: "detail", deviceId });
          }}
        />
      ) : devices.mode === "provision" ? (
        <ProvisionPanel
          initialDeviceId={devices.selectedDeviceId ?? ""}
          viewer={viewer}
          pendingAction={devices.pendingAction}
          issuedToken={devices.issuedToken}
          onBack={() => {
            devices.writeRoute({ mode: "detail", deviceId: null });
          }}
          onSubmit={(form) => void devices.createToken(form)}
        />
      ) : (
        <DeviceDetailPanel
          device={selected}
          viewer={viewer}
          activeTab={devices.activeTab}
          tokens={devices.state?.deviceTokens ?? []}
          pendingAction={devices.pendingAction}
          onTab={(tab) => devices.writeRoute({ tab })}
          onBackToFleet={() => devices.writeRoute({ mode: "detail", deviceId: null })}
          onProvision={(deviceId) => {
            devices.setIssuedToken(null);
            devices.writeRoute({ mode: "provision", deviceId });
          }}
          onRevoke={(tokenId) => void devices.revokeToken(tokenId)}
          onUpdateDescription={(deviceId, description) => void devices.updateDescription(deviceId, description)}
        />
      )}
    </section>
  );
}
