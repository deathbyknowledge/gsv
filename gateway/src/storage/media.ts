/**
 * R2 Storage helpers for GSV
 *
 * Storage structure (matching clawdbot pattern):
 * gsv-storage/
 * └── agents/{agentId}/
 *     └── sessions/
 *         └── {sessionId}.jsonl.gz    # Archived transcript for a reset session
 *
 */

import type { MediaAttachment } from "../protocol/channel";

export const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024; // 25MB limit

const BYTE_TO_BASE64_CHUNK_SIZE = 0x1000; // 4KB (avoids argument-list stack overflows)

function uint8ArrayToBase64(data: Uint8Array): string {
  if (data.length === 0) return "";

  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += BYTE_TO_BASE64_CHUNK_SIZE) {
    const chunk = data.subarray(i, i + BYTE_TO_BASE64_CHUNK_SIZE);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

export async function storeMediaInR2(
  attachment: MediaAttachment,
  bucket: R2Bucket,
  sessionKey: string,
): Promise<string> {
  if (!attachment.data) {
    throw new Error("Media attachment missing base64 data");
  }

  const binaryData = Uint8Array.from(atob(attachment.data), c => c.charCodeAt(0));
  
  if (binaryData.byteLength > MAX_MEDIA_SIZE_BYTES) {
    throw new Error(`Media file too large (${(binaryData.byteLength / 1024 / 1024).toFixed(1)}MB > 25MB limit)`);
  }

  const ext = getExtensionFromMime(attachment.mimeType);
  const uuid = crypto.randomUUID();
  const r2Key = `media/${sessionKey}/${uuid}.${ext}`;

  await bucket.put(r2Key, binaryData, {
    httpMetadata: {
      contentType: attachment.mimeType,
    },
    customMetadata: {
      originalFilename: attachment.filename || "",
      uploadedAt: Date.now().toString(),
      sessionKey,
    },
  });

  console.log(`[MediaStore] Stored ${attachment.type} in R2: ${r2Key} (${binaryData.byteLength} bytes)`);
  return r2Key;
}

export async function fetchMediaFromR2(
  r2Key: string,
  bucket: R2Bucket,
): Promise<{ data: string; mimeType: string } | null> {
  const object = await bucket.get(r2Key);
  if (!object) {
    console.log(`[MediaStore] Not found in R2: ${r2Key}`);
    return null;
  }

  const arrayBuffer = await object.arrayBuffer();
  const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
  const mimeType = object.httpMetadata?.contentType || "application/octet-stream";

  console.log(`[MediaStore] Fetched from R2: ${r2Key} (${arrayBuffer.byteLength} bytes)`);
  return { data: base64, mimeType };
}

export async function deleteSessionMedia(
  bucket: R2Bucket,
  sessionKey: string,
): Promise<number> {
  const prefix = `media/${sessionKey}/`;
  let deleted = 0;
  let cursor: string | undefined;

  // List and delete all objects with this prefix
  do {
    const listed = await bucket.list({ prefix, cursor });
    
    if (listed.objects.length > 0) {
      const keys = listed.objects.map(obj => obj.key);
      await bucket.delete(keys);
      deleted += keys.length;
    }
    
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (deleted > 0) {
    console.log(`[MediaStore] Deleted ${deleted} media files for session ${sessionKey}`);
  }
  return deleted;
}

export async function processInboundMedia(
  media: MediaAttachment[] | undefined,
  bucket: R2Bucket,
  sessionKey: string,
): Promise<MediaAttachment[]> {
  if (!media || media.length === 0) {
    return [];
  }

  const processed: MediaAttachment[] = [];

  for (const attachment of media) {
    // Skip if already has r2Key (shouldn't happen for inbound)
    if (attachment.r2Key) {
      processed.push(attachment);
      continue;
    }

    // Skip if no data
    if (!attachment.data) {
      processed.push(attachment);
      continue;
    }

    try {
      const r2Key = await storeMediaInR2(attachment, bucket, sessionKey);
      
      // Return attachment with r2Key, strip base64 data
      processed.push({
        type: attachment.type,
        mimeType: attachment.mimeType,
        r2Key,
        filename: attachment.filename,
        size: attachment.size,
        duration: attachment.duration,
        transcription: attachment.transcription,
        // data is intentionally omitted
      });
    } catch (e) {
      console.error(`[MediaStore] Failed to store media:`, e);
      // On failure, keep the attachment as-is (with data) so it can still be used
      processed.push(attachment);
    }
  }

  return processed;
}

function getExtensionFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    // Images
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    // Audio
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
    // Video
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    // Documents
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };

  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  return mimeMap[baseMime] || "bin";
}
