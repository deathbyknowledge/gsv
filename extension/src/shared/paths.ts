export function normalizePath(path: string | undefined, cwd = "/"): string {
  const input = (path ?? "").trim();
  const raw = input ? input : cwd;
  const parts = raw.startsWith("/")
    ? raw.split("/")
    : `${cwd.replace(/\/+$/, "")}/${raw}`.split("/");
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  return `/${stack.join("/")}`;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return "/";
  }
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return "/";
  }
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function joinPath(parent: string, child: string): string {
  return normalizePath(`${normalizePath(parent).replace(/\/+$/, "")}/${child}`);
}
