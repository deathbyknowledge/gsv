# GSV object icons

Static, committed dot-matrix SVGs generated once from `gsv-dot-icons.js` (MODE `16`).
No runtime JS icon library. Each file uses `fill="currentColor"` on a `0 0 512 512`
viewBox, so it can be tinted via CSS.

## Usage

- Fixed color: `<img src="/icons/folder.svg">`
- Token tinting: `mask-image: url(/icons/folder.svg); -webkit-mask-image: url(/icons/folder.svg); background-color: var(--accent-bright)` (set `mask-size`/`mask-repeat` as needed).
- The `currentColor` fill also lets you inline the SVG and tint it with `color`.

## object key → icon name → filename

| object key   | icon name | filename       |
| ------------ | --------- | -------------- |
| machines     | computer  | computer.svg   |
| machine      | computer  | computer.svg   |
| messengers   | chat      | chat.svg       |
| discord      | discord   | discord.svg    |
| telegram     | telegram  | telegram.svg   |
| integrations | weblink   | weblink.svg    |
| mail         | gmail     | gmail.svg      |
| linear       | list      | list.svg       |
| applications | stars     | stars.svg      |
| game         | stars     | stars.svg      |
| scanner      | stars     | stars.svg      |
| coach        | stars     | stars.svg      |
| files        | folder    | folder.svg     |
| settings     | cog       | cog.svg        |
| cat          | tag       | tag.svg        |
| satellite    | rss       | rss.svg        |
| add          | plus      | plus.svg       |
| library      | pencil    | pencil.svg     |
| terminal     | terminal  | terminal.svg   |
| tabs         | bookmark  | bookmark.svg   |

`computer`, `plus`, `terminal` are the custom-drawn `added` icons.
`pencil`/`terminal`/`bookmark` double as chrome aliases (library/terminal/tabs).

## Two sets

**GSV curated set (16)** — `/icons/<name>.svg`, generated from `gsv-dot-icons.js`
(16-grid). The object/chrome vocabulary the app actually uses:
bookmark, chat, cog, computer, discord, folder, gmail, list, pencil, plus, rss,
stars, tag, telegram, terminal, weblink.
(`computer`, `plus`, `terminal` are the custom-drawn `added` icons — not in doticons.)

**Full doticons library (247)** — `/icons/doticons/<name>.svg`, vendored from
[eduardconstantin/doticons@v0.9.0](https://github.com/eduardconstantin/doticons)
`icons/32` (32-grid, MIT). The complete reference set, shown in the catalog's
"Other icons" drawer. Name list mirrored in `web/src/design-system/doticons.ts`.
