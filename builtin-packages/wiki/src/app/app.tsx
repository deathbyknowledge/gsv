import { WikiHeader } from "./components/header/wiki-header";
import { WikiRail } from "./components/navigation/wiki-rail";
import { BrowsePane } from "./components/panes/browse-pane";
import { BuildPane } from "./components/panes/build-pane";
import { EditPane } from "./components/panes/edit-pane";
import { IngestPane } from "./components/panes/ingest-pane";
import { PreviewCard } from "./preview-card";
import { useWikiPreview } from "./hooks/use-wiki-preview";
import { useWikiWorkspace } from "./hooks/use-wiki-workspace";
import { suggestPagePath } from "./domain/wiki-model";
import type { WikiBackend } from "./types";

export function App({ backend, routeBase }: { backend: WikiBackend; routeBase: string }) {
  const wiki = useWikiWorkspace(backend);
  const {
    previewRect,
    previewLoading,
    previewPayload,
    previewError,
    previewPinned,
    handleArticlePreviewOpen,
    hidePreview,
    keepPreviewOpen,
  } = useWikiPreview(backend);

  return (
    <div class="wiki-shell">
      <WikiHeader
        activeDb={wiki.activeDb}
        selectedDb={wiki.selectedDb}
        searchDraft={wiki.searchDraft}
        searchQuery={wiki.state.searchQuery}
        searchMatches={wiki.state.searchMatches}
        searchOpen={wiki.searchOpen}
        searching={wiki.searching}
        onSearchDraftChange={wiki.setSearchDraft}
        onSearchFocus={() => wiki.setSearchOpen(true)}
        onApplySearch={wiki.applySearch}
        onClearSearch={wiki.clearSearch}
        onOpenMatch={wiki.openSearchMatch}
      />

      <div class="wiki-layout">
        <WikiRail
          mode={wiki.mode}
          routeBase={routeBase}
          onChangeMode={wiki.changeMode}
          state={wiki.state}
          selectedDb={wiki.selectedDb}
          visiblePages={wiki.visiblePages}
          mutating={wiki.mutating}
          newDatabaseOpen={wiki.newDatabaseOpen}
          newDatabaseTitle={wiki.newDatabaseTitle}
          newDatabaseId={wiki.newDatabaseId}
          onOpenDb={wiki.openDb}
          onOpenPage={wiki.openPageAndBrowse}
          onNewPage={() => wiki.setMode("edit")}
          onToggleCreateDatabase={() => wiki.setNewDatabaseOpen((open) => !open)}
          onCreateDatabase={wiki.createDatabaseFlow}
          onNewDatabaseTitleChange={wiki.setNewDatabaseTitle}
          onNewDatabaseIdChange={wiki.setNewDatabaseId}
        />

        <main class="wiki-main">
          {wiki.loading ? <div class="wiki-empty">Loading wiki...</div> : null}
          {!wiki.loading && wiki.error ? <div class="wiki-status is-error">{wiki.error}</div> : null}
          {!wiki.loading && !wiki.error && wiki.notice ? <div class="wiki-status is-info">{wiki.notice}</div> : null}

          {!wiki.loading ? (
            <>
              {wiki.mode === "browse" ? (
                <BrowsePane
                  state={wiki.state}
                  currentTitle={wiki.currentTitle}
                  routeBase={routeBase}
                  selectedDb={wiki.selectedDb}
                  pageHeadings={wiki.pageHeadings}
                  onOpenPage={wiki.openPage}
                  onEditPage={() => wiki.setMode("edit")}
                  onPreviewOpen={handleArticlePreviewOpen}
                  onPreviewHide={hidePreview}
                />
              ) : null}

              {wiki.mode === "edit" ? (
                <EditPane
                  mutating={wiki.mutating}
                  editorPath={wiki.editorPath}
                  editorMarkdown={wiki.editorMarkdown}
                  newPageTitle={wiki.newPageTitle}
                  onSaveCurrentPage={wiki.saveCurrentPage}
                  onCreatePage={wiki.createPage}
                  onUseSuggestedPath={() => wiki.setEditorPath(suggestPagePath(wiki.selectedDb, wiki.newPageTitle, wiki.state.selectedPath))}
                  onNewPageTitleChange={wiki.setNewPageTitle}
                  onEditorPathChange={wiki.setEditorPath}
                  onEditorMarkdownChange={wiki.setEditorMarkdown}
                />
              ) : null}

              {wiki.mode === "build" ? (
                <BuildPane
                  state={wiki.state}
                  selectedDb={wiki.selectedDb}
                  mutating={wiki.mutating}
                  buildTargetMode={wiki.buildTargetMode}
                  buildTargetCustom={wiki.buildTargetCustom}
                  buildSourcePath={wiki.buildSourcePath}
                  buildDestinationMode={wiki.buildDestinationMode}
                  buildSelectedDb={wiki.buildSelectedDb}
                  buildDbTitle={wiki.buildDbTitle}
                  buildDbId={wiki.buildDbId}
                  onStartBuild={wiki.startBuildFlow}
                  onBuildTargetModeChange={wiki.setBuildTargetMode}
                  onBuildTargetCustomChange={wiki.setBuildTargetCustom}
                  onBuildSourcePathChange={wiki.setBuildSourcePath}
                  onBuildDestinationModeChange={wiki.setBuildDestinationMode}
                  onBuildSelectedDbChange={wiki.setBuildSelectedDb}
                  onBuildDbTitleChange={wiki.setBuildDbTitle}
                  onBuildDbIdChange={wiki.setBuildDbId}
                />
              ) : null}

              {wiki.mode === "ingest" ? (
                <IngestPane
                  state={wiki.state}
                  selectedDb={wiki.selectedDb}
                  mutating={wiki.mutating}
                  ingestDb={wiki.ingestDb}
                  ingestTargetMode={wiki.ingestTargetMode}
                  ingestTargetCustom={wiki.ingestTargetCustom}
                  ingestSourcePath={wiki.ingestSourcePath}
                  ingestSourceTitle={wiki.ingestSourceTitle}
                  ingestSummary={wiki.ingestSummary}
                  onIngestSource={wiki.ingestSourceFlow}
                  onIngestDbChange={wiki.setIngestDb}
                  onIngestTargetModeChange={wiki.setIngestTargetMode}
                  onIngestTargetCustomChange={wiki.setIngestTargetCustom}
                  onIngestSourcePathChange={wiki.setIngestSourcePath}
                  onIngestSourceTitleChange={wiki.setIngestSourceTitle}
                  onIngestSummaryChange={wiki.setIngestSummary}
                />
              ) : null}

            </>
          ) : null}
        </main>

      </div>

      {previewRect ? (
        <PreviewCard
          anchorRect={previewRect}
          loading={previewLoading}
          payload={previewPayload}
          error={previewError}
          pinned={previewPinned}
          routeBase={routeBase}
          selectedDb={wiki.selectedDb}
          onDismiss={() => hidePreview(true)}
          onMouseEnter={keepPreviewOpen}
          onMouseLeave={() => hidePreview(false)}
          onOpenPage={(path) => {
            hidePreview(true);
            wiki.openPageAndBrowse(path);
          }}
        />
      ) : null}
    </div>
  );
}
