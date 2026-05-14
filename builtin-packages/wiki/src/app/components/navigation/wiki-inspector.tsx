type WikiHeading = {
  level: number;
  text: string;
  id: string;
};

type Props = {
  pageHeadings: WikiHeading[];
  currentTitle: string;
  selectedDb: string;
  selectedPath: string;
};

export function WikiInspector(props: Props) {
  return (
    <aside class="wiki-inspector">
      <section class="wiki-inspector-section">
        <h2>Page</h2>
        <dl class="wiki-meta-list">
          <div>
            <dt>Title</dt>
            <dd title={props.currentTitle || undefined}>{props.currentTitle || "No page selected"}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd title={props.selectedDb || undefined}>{props.selectedDb || "None"}</dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd title={props.selectedPath || undefined}>{props.selectedPath || "None"}</dd>
          </div>
        </dl>
      </section>
      {props.pageHeadings.length > 0 ? (
        <section class="wiki-inspector-section">
          <h2>Outline</h2>
          <div class="wiki-outline-list">
            {props.pageHeadings.map((heading) => (
              <a key={heading.id} href={`#${heading.id}`} class={`wiki-outline-row level-${heading.level}`}>{heading.text}</a>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
}
