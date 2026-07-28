import type { ShellFilesRoute } from "../gsv-shell/domain/shellModel";
import { FilesSurfaceSummary } from "./components/FilesSurfaceSummary";

export function FilesPage({ filesRoute }: { filesRoute?: ShellFilesRoute }) {
  return <FilesSurfaceSummary initialLocation={filesRoute ?? null} />;
}
