import type { Translate } from "../../i18n/locale";
import type { NativeSnapshot, NativeVoice } from "./PlatformProvider";

type VoicePreparation = { message: string; progress: number | undefined };

export function voicePreparation(t: Translate, voice: NativeVoice | null | undefined): VoicePreparation | null {
  switch (voice?.phase) {
    case "preparing":
      return { message: t("desktop.voice.model.preparing"), progress: undefined };
    case "downloading":
      return {
        message: voice.progress == null ? t("desktop.voice.model.downloading") : t("desktop.voice.model.downloadProgress", { percent: Math.round(voice.progress * 100) }),
        progress: voice.progress ?? undefined,
      };
    case "verifying":
      return { message: t("desktop.voice.model.verifying"), progress: undefined };
    case "loading":
      return { message: t("desktop.voice.model.loading"), progress: undefined };
    default:
      return null;
  }
}

/** Transport acknowledgements and dictated text do not invalidate the input controls. */
export function sameNativePresentation(a: NativeSnapshot | null, b: NativeSnapshot): boolean {
  if (!a || a.lease !== b.lease || a.notice !== b.notice || a.devices_loading !== b.devices_loading) return false;
  if (Boolean(a.voice) !== Boolean(b.voice)) return false;
  if (a.voice && b.voice && (a.voice.request_id !== b.voice.request_id || a.voice.phase !== b.voice.phase
    || a.voice.progress !== b.voice.progress || a.voice.muted !== b.voice.muted
    || a.voice.pending !== b.voice.pending)) return false;
  return a.devices.length === b.devices.length && a.devices.every((device, index) => {
    const next = b.devices[index];
    return device.id === next.id && device.name === next.name && device.is_default === next.is_default;
  });
}
