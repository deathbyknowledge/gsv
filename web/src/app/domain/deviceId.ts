export const DEVICE_ID_MAX_LENGTH = 48;
export const DEVICE_ID_FORMAT_DESCRIPTION =
  "Use 1-48 lowercase letters, numbers, underscores, or hyphens, starting with a letter or number.";

export function parseDeviceId(value: string): string | null {
  const deviceId = value.trim();
  return deviceId.length <= DEVICE_ID_MAX_LENGTH && /^[a-z0-9][a-z0-9_-]*$/.test(deviceId)
    ? deviceId
    : null;
}
