export function detectPathStyle(path: string): "absolute" | "relative" {
  return String(path ?? "").trim().startsWith("/") ? "absolute" : "relative";
}

export function normalizeTarget(target: string) {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

export function defaultPathForTarget(target: string) {
  return normalizeTarget(target) === "gsv" ? "" : ".";
}

export function normalizePath(input: string, style: "absolute" | "relative" = detectPathStyle(input)) {
  const raw = String(input ?? "").replaceAll("\\", "/").trim();
  const normalized: string[] = [];

  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  if (style === "absolute") {
    return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
  }
  return normalized.length > 0 ? normalized.join("/") : ".";
}

export function parentPath(path: string, style: "absolute" | "relative" = detectPathStyle(path)) {
  const normalized = normalizePath(path, style);
  if (style === "absolute") {
    if (normalized === "/") {
      return "/";
    }
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  if (normalized === ".") {
    return ".";
  }

  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

export function resolveChildPath(base: string, name: string) {
  if (base === "/") {
    return `/${name}`;
  }
  if (base === ".") {
    return name;
  }
  return `${base}/${name}`;
}
