import { Search } from "../../app/components/ui/Search";
import type { Story } from "../story";

const noop = () => {};

const story: Story = {
  title: "Search",
  group: "Forms",
  blurb: "TextInput-based field · leading magnifier · clearable · Enter to search",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Search size="small" label="SMALL" onSearch={noop} />
          <Search size="medium" label="MEDIUM" onSearch={noop} />
          <Search size="large" label="LARGE" onSearch={noop} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Label & requirement</div>
        <div class="ds-col">
          <Search onSearch={noop} />
          <Search label="WITH LABEL" onSearch={noop} />
          <Search label="REQUIRED" requirement="required" onSearch={noop} />
          <Search label="OPTIONAL" requirement="optional" onSearch={noop} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-col">
          <Search label="ERROR" status="error" message="No matches found" value="zzz" onSearch={noop} />
          <Search label="SUCCESS" status="success" message="12 results" value="agent" onSearch={noop} />
          <Search label="INFO" status="info" message="Searches names and tags" value="primary" onSearch={noop} />
          <Search label="WARNING" status="warning" message="Broad query — may be slow" value="a" onSearch={noop} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States & extras</div>
        <div class="ds-col">
          <Search label="CLEARABLE (has value)" value="primary agent" onSearch={noop} />
          <Search label="READONLY" readonly value="locked query" onSearch={noop} />
          <Search label="DISABLED" disabled value="disabled query" onSearch={noop} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Width — bounded vs. block</div>
        <div class="ds-col">
          <Search label="BOUNDED (default)" placeholder="bounded width" onSearch={noop} />
          <Search label="BLOCK (full width)" block placeholder="stretches to fill" onSearch={noop} />
        </div>
      </div>
    </div>
  ),
};

export default story;
