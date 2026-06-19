export function hasHelpFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-h" || arg === "--help");
}

export function parseInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function requiredInteger(value: string | undefined, label: string): number {
  const parsed = parseInteger(value);
  if (parsed === null) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

export function splitOption(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) {
      value = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
      continue;
    }
    rest.push(arg);
  }

  return { value, rest };
}

export function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
