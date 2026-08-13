import { ChatMediaAttachment } from "../../chat/components/ChatMediaAttachment";
import "./TextClientMedia.css";

type TextClientMediaProps = {
  items: readonly unknown[];
  momentKey: string;
  processId: string;
};

/**
 * Keep process-media loading at the shared chat boundary while giving the
 * text-first client its own presentation. Stored bodies still flow through
 * proc.media.read and ChatMediaAttachment owns each object URL's lifetime.
 */
export function TextClientMedia({ items, momentKey, processId }: TextClientMediaProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      class="text-client-media"
      aria-label={`${items.length} ${items.length === 1 ? "attachment" : "attachments"}`}
    >
      {items.map((media, index) => (
        <ChatMediaAttachment
          key={`${momentKey}:media:${index}`}
          media={media}
          processId={processId}
        />
      ))}
    </div>
  );
}
