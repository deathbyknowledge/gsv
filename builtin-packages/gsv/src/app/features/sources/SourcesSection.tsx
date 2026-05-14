import type { GsvBackend } from "../../backend-contract";
import type { PackagesRouteView } from "../../navigation/route-state";
import { RepoSidebar } from "./SourceSidebar";
import { RepoWorkspace } from "./SourceWorkspace";
import { useSources } from "./useSources";

export function SourcesSection({
  backend,
  onOpenPackage,
}: {
  backend: GsvBackend;
  onOpenPackage?: (packageId: string, view?: PackagesRouteView) => void;
}) {
  const runtime = useSources(backend);
  const repoView = runtime.repositoryRoute !== null;

  return (
    <section class={`gsv-sources${repoView ? " is-repo-view" : " is-list-view"}`}>
      {repoView ? (
        <RepoWorkspace runtime={runtime} onOpenPackage={onOpenPackage} />
      ) : (
        <RepoSidebar runtime={runtime} />
      )}
    </section>
  );
}
