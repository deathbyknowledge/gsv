import { TextInput } from "./TextInput";
import type {
  TextInputRequirement,
  TextInputSize,
  TextInputStatus,
} from "./TextInput";
import "./Search.css";

export interface SearchProps {
  value?: string;
  placeholder?: string;
  label?: string;
  info?: string;
  description?: string;
  size?: TextInputSize;
  status?: TextInputStatus;
  message?: string;
  requirement?: TextInputRequirement;
  disabled?: boolean;
  readonly?: boolean;
  /** Full-width when true; otherwise the field keeps a bounded intrinsic width. */
  block?: boolean;
  /** Optional fixed width in px. Overrides the default bounded width. */
  width?: number;
  maxLength?: number;
  onChange?: (value: string) => void;
  /** Fired when the user presses Enter in the field. */
  onSearch?: (value: string) => void;
}

/** Magnifier glyph — geometric, currentColor, matching the IconButton glyph
 *  style. Decorative; the field itself carries the accessible label. */
function SearchGlyph() {
  return (
    <svg
      class="gsv-search-glyph"
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.4" y1="10.4" x2="14" y2="14" />
    </svg>
  );
}

/** Search — a TextInput-based field with a leading magnifier, clearable by
 *  default, and Enter-to-submit. Inherits TextInput's full field-shell
 *  (label / info / description / status / message / sizes / states). */
export function Search(props: SearchProps) {
  const {
    value,
    placeholder = "Search…",
    label,
    info,
    description,
    size,
    status,
    message,
    requirement,
    disabled,
    readonly,
    block = false,
    width,
    maxLength,
    onChange,
    onSearch,
  } = props;

  // Non-block keeps a bounded width; block stretches to the parent. An explicit
  // `width` always wins. The wrapper drives sizing since `.gsv-ti` is 100%.
  const style = width !== undefined ? { width: `${width}px` } : undefined;
  const wrapClass = `gsv-search${block ? " is-block" : ""}`;

  // TextInput's field-shell has no dedicated `info` slot, so we surface `info`
  // through its `description` row when no explicit description is given.
  const desc = description ?? info;

  return (
    <div class={wrapClass} style={style}>
      <TextInput
        value={value}
        placeholder={placeholder}
        label={label ?? ""}
        description={desc ?? ""}
        size={size}
        status={status}
        message={message}
        requirement={requirement}
        disabled={disabled}
        readonly={readonly}
        clearable
        maxLength={maxLength}
        prefix={<SearchGlyph />}
        onChange={onChange}
        inputProps={{
          // TextInput manages `type`/`value`/`id`; only non-managed attrs stick.
          role: "searchbox",
          enterKeyHint: "search",
          onKeyDown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSearch?.((e.currentTarget as HTMLInputElement).value);
            }
          },
        }}
      />
    </div>
  );
}
