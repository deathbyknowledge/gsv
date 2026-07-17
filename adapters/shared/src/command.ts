export type ParsedAttachArgs = {
  targetId?: string;
  url?: string;
  filename?: string;
  caption: string;
};

export function parseShellWords(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input.trim())) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return tokens;
}

export function isHelpCommand(command: string): boolean {
  return command === "help" || command === "-h" || command === "--help";
}

export function parseAttachArgs(tokens: string[]): ParsedAttachArgs {
  const [targetId, url, ...rest] = tokens;
  if (rest.length === 0) {
    return { targetId, url, caption: "" };
  }

  if (rest[0] === "--filename" || rest[0] === "-f") {
    const [, filename, ...captionParts] = rest;
    return {
      targetId,
      url,
      filename,
      caption: captionParts.join(" ").trim(),
    };
  }

  const [candidate, ...captionParts] = rest;
  if (looksLikeFilename(candidate)) {
    return {
      targetId,
      url,
      filename: candidate,
      caption: captionParts.join(" ").trim(),
    };
  }

  return {
    targetId,
    url,
    caption: rest.join(" ").trim(),
  };
}

export function inferMediaMimeType(url: string, filename?: string): string {
  let candidate = filename?.trim() || "";
  if (!candidate) {
    try {
      candidate = new URL(url).pathname;
    } catch {
      candidate = url;
    }
  }
  const extension = candidate.split(/[./\\]/).pop()?.toLowerCase() || "";
  const mimeByExtension: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    zip: "application/zip",
  };
  return mimeByExtension[extension] || "application/octet-stream";
}

function looksLikeFilename(value: string | undefined): value is string {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return true;
  return /^[^/?#\s]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
