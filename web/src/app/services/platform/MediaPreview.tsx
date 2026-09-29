import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

export type ImagePreview = { source: string; filename: string; description: string };
type PreviewImage = (image: ImagePreview) => void;
const Preview = createContext<PreviewImage | null>(null);

/** Browsers open image links themselves; embedded hosts can supply an in-app viewer. */
export function MediaPreviewProvider({ preview, children }: { preview: PreviewImage; children: ComponentChildren }) {
  return <Preview.Provider value={preview}>{children}</Preview.Provider>;
}

export const useMediaPreview = () => useContext(Preview);
