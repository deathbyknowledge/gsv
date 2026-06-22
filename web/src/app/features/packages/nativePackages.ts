const NATIVE_WEB_PACKAGE_NAMES = new Set([
  "@gsv/chat",
  "@gsv/files",
  "@gsv/gsv",
  "@gsv/shell",
  "@gsv/wiki",
]);

export function isNativeWebPackageName(value: string | null | undefined): boolean {
  return NATIVE_WEB_PACKAGE_NAMES.has(value?.trim() ?? "");
}
