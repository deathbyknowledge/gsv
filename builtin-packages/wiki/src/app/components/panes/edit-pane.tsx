type Props = {
  mutating: boolean;
  editorPath: string;
  editorMarkdown: string;
  newPageTitle: string;
  onSaveCurrentPage(): Promise<void> | void;
  onCreatePage(): Promise<void> | void;
  onUseSuggestedPath(): void;
  onNewPageTitleChange(value: string): void;
  onEditorPathChange(value: string): void;
  onEditorMarkdownChange(value: string): void;
};

export function EditPane(props: Props) {
  return (
    <section class="wiki-pane wiki-pane--editor">
      <div class="wiki-pane-head">
        <div>
          <h2>Edit page</h2>
          <p>Write canonical pages without hand-building paths unless you want to.</p>
        </div>
        <div class="wiki-pane-actions">
          <button type="button" onClick={() => void props.onSaveCurrentPage()} disabled={props.mutating} title="Save current page" aria-label="Save current page">Save</button>
        </div>
      </div>
      <div class="wiki-form-grid">
        <label>
          <span>Page title</span>
          <input value={props.newPageTitle} onInput={(event) => props.onNewPageTitleChange((event.currentTarget as HTMLInputElement).value)} placeholder="New page title" />
        </label>
        <label>
          <span>Path</span>
          <input value={props.editorPath} onInput={(event) => props.onEditorPathChange((event.currentTarget as HTMLInputElement).value)} placeholder="database/pages/page.md" />
        </label>
      </div>
      <div class="wiki-inline-actions">
        <button type="button" onClick={() => void props.onCreatePage()} disabled={props.mutating || !props.newPageTitle.trim()} title="Create page" aria-label="Create page">Create</button>
        <button type="button" class="is-secondary" onClick={props.onUseSuggestedPath} title="Use suggested path" aria-label="Use suggested path">Suggest path</button>
      </div>
      <textarea class="wiki-editor" value={props.editorMarkdown} onInput={(event) => props.onEditorMarkdownChange((event.currentTarget as HTMLTextAreaElement).value)} placeholder="Write markdown for the current page." />
    </section>
  );
}
