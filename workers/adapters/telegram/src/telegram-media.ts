import type { AdapterMedia } from "./types";

const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

type TelegramMediaGroupKind = "visual" | "audio" | "document";

function getTelegramMediaGroupKind(
  mediaType: AdapterMedia["type"],
): TelegramMediaGroupKind {
  switch (mediaType) {
    case "image":
    case "video":
      return "visual";
    case "audio":
      return "audio";
    case "document":
      return "document";
  }
}

export function planTelegramMediaDeliveries(
  mediaItems: readonly AdapterMedia[],
): AdapterMedia[][] {
  const deliveries: AdapterMedia[][] = [];
  let currentGroup: AdapterMedia[] = [];
  let currentKind: TelegramMediaGroupKind | undefined;

  for (const media of mediaItems) {
    const kind = getTelegramMediaGroupKind(media.type);
    if (
      currentGroup.length > 0 &&
      (kind !== currentKind || currentGroup.length === TELEGRAM_MEDIA_GROUP_LIMIT)
    ) {
      deliveries.push(currentGroup);
      currentGroup = [];
    }

    currentKind = kind;
    currentGroup.push(media);
  }

  if (currentGroup.length > 0) {
    deliveries.push(currentGroup);
  }

  return deliveries;
}
