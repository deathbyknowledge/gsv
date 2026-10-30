import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useState } from "preact/hooks";
import { AttachmentPreview } from "./AttachmentPreview";

type Attachment = { blob: Blob; mimeType: string; filename: string; description: string };
const Preview = createContext<((attachment: Attachment) => void) | null>(null);

/** The signed-in shell, not a pageable message row, owns the active attachment. */
export function AttachmentPreviews({ children }: { children: ComponentChildren }) {
  const [preview, setPreview] = useState<{ attachment: Attachment; id: number } | null>(null);
  const open = useCallback((attachment: Attachment) => {
    setPreview((previous) => ({ attachment, id: (previous?.id ?? 0) + 1 }));
  }, []);
  return <Preview.Provider value={open}>
    {children}
    {preview && <AttachmentPreview key={preview.id} {...preview.attachment} onClose={() => setPreview(null)} />}
  </Preview.Provider>;
}

export const useAttachmentPreview = () => useContext(Preview);
