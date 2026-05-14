import type { ShellDevice } from "./types";
import { escapeHtml } from "./layout";

export function currentTarget(targetSelect: HTMLSelectElement): string {
  return targetSelect.value ? targetSelect.value : "gsv";
}

export function setSelectedTarget(targetSelect: HTMLSelectElement, target: string | null | undefined): void {
  const normalizedTarget = target?.trim() || "";
  const availableOption = Array.from(targetSelect.options).find((option) => option.value === normalizedTarget);
  targetSelect.value = availableOption ? normalizedTarget : "gsv";
}

export function selectedTargetUnavailable(targetSelect: HTMLSelectElement): boolean {
  return targetSelect.selectedOptions[0]?.disabled === true;
}

export function renderTargetOptions(targetSelect: HTMLSelectElement, devices: ShellDevice[], requestedTarget?: string | null): void {
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [{ value: "gsv", label: "Kernel (gsv)" }];
  const normalizedRequestedTarget = requestedTarget?.trim() || "";
  if (normalizedRequestedTarget && normalizedRequestedTarget !== "gsv" && !devices.some((device) => device.deviceId === normalizedRequestedTarget)) {
    options.push({ value: normalizedRequestedTarget, label: `${normalizedRequestedTarget} · requested target` });
  }
  options.push(
    ...devices.map((device) => {
      const labelBase = device.label && device.label !== device.deviceId
        ? `${device.label} · ${device.deviceId}`
        : device.deviceId;
      return {
        value: device.deviceId,
        label: `${labelBase} · ${device.online ? "online" : "offline"}`,
        disabled: !device.online,
      };
    }),
  );
  targetSelect.innerHTML = options
    .map((option) => (
      `<option value="${escapeHtml(option.value)}"${option.disabled ? " disabled" : ""}>${escapeHtml(option.label)}</option>`
    ))
    .join("");
  setSelectedTarget(targetSelect, normalizedRequestedTarget);
}
