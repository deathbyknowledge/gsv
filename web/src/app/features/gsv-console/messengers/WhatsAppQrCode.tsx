import { useEffect, useState } from "preact/hooks";
import {
  isWhatsAppQrImageDataUrl,
  type WhatsAppQrSource,
} from "./whatsappPairing";
import "./WhatsAppPairing.css";

export type WhatsAppQrCodeDependencies = {
  useEffect: typeof useEffect;
  useState: (initialValue: string | (() => string)) => [string, (value: string) => void];
};

const defaultDependencies: WhatsAppQrCodeDependencies = { useEffect, useState };

export async function renderWhatsAppQrImageUrl(source: WhatsAppQrSource): Promise<string> {
  if (source.kind === "data-url") {
    if (!isWhatsAppQrImageDataUrl(source.value)) {
      throw new Error("Unsupported WhatsApp QR image data");
    }
    return source.value;
  }
  const { default: QRCode } = await import("qrcode");
  const svg = await QRCode.toString(source.value, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 288,
    color: {
      dark: "#080717",
      light: "#ffffff",
    },
  });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function WhatsAppQrCode({
  source,
  onRenderError,
  dependencies = defaultDependencies,
}: {
  source: WhatsAppQrSource;
  onRenderError?: () => void;
  dependencies?: WhatsAppQrCodeDependencies;
}) {
  const [imageUrl, setImageUrl] = dependencies.useState(
    source.kind === "data-url" && isWhatsAppQrImageDataUrl(source.value)
      ? source.value
      : "",
  );

  dependencies.useEffect(() => {
    let active = true;
    setImageUrl("");
    void renderWhatsAppQrImageUrl(source).then((url) => {
      if (active) {
        setImageUrl(url);
      }
    }).catch(() => {
      if (active) {
        setImageUrl("");
        onRenderError?.();
      }
    });

    return () => {
      active = false;
    };
  }, [onRenderError, source.kind, source.value]);

  return (
    <div class="gsv-whatsapp-qr-frame" aria-live="polite">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="WhatsApp linked-device QR code"
          onError={() => {
            setImageUrl("");
            onRenderError?.();
          }}
        />
      ) : (
        <div class="gsv-whatsapp-qr-loading gsv-sublabel">GENERATING SECURE QR CODE</div>
      )}
    </div>
  );
}
