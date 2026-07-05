type ClipboardDataLike = {
  files?: ArrayLike<File> | Iterable<File>;
  getData?: (format: string) => string;
  items?: ArrayLike<DataTransferItem> | Iterable<DataTransferItem>;
};

function toArray<T>(value: ArrayLike<T> | Iterable<T> | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.from(value);
}

function imageExtension(mimeType: string): string {
  switch (mimeType.split(";")[0].trim().toLowerCase()) {
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/tiff":
      return "tiff";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function isImageFile(file: File, hintedType = ""): boolean {
  return file.type.toLowerCase().startsWith("image/")
    || hintedType.toLowerCase().startsWith("image/")
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name);
}

function normalizeClipboardImageFile(file: File, hintedType: string, index: number): File {
  const mimeType = file.type || hintedType;
  if ((file.type && file.name) || typeof File === "undefined") {
    return file;
  }
  const filename = file.name || `pasted-image-${index + 1}.${imageExtension(mimeType)}`;
  return new File([file], filename, {
    type: mimeType || "image/png",
    lastModified: file.lastModified,
  });
}

function imageFileFromDataUrl(dataUrl: string, index: number): File | null {
  if (typeof File === "undefined" || typeof atob !== "function") {
    return null;
  }

  const match = dataUrl.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
    bytes[byteIndex] = binary.charCodeAt(byteIndex);
  }
  return new File([bytes], `pasted-image-${index + 1}.${imageExtension(mimeType)}`, {
    type: mimeType,
  });
}

function htmlDataImageFiles(html: string): File[] {
  const files: File[] = [];
  const matches = html.matchAll(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi);
  for (const match of matches) {
    const file = imageFileFromDataUrl(match[0], files.length);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

export function clipboardImageFiles(data: ClipboardDataLike | null): File[] {
  if (!data) {
    return [];
  }

  const files: File[] = [];
  for (const item of toArray(data.items)) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file && isImageFile(file, item.type)) {
      files.push(normalizeClipboardImageFile(file, item.type, files.length));
    }
  }

  if (files.length > 0) {
    return files;
  }

  const transferFiles = toArray(data.files).filter((file) => isImageFile(file));
  if (transferFiles.length > 0) {
    return transferFiles;
  }

  const html = data.getData?.("text/html") ?? "";
  return html ? htmlDataImageFiles(html) : [];
}
