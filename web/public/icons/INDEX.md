# GSV icons

Static, committed dot-matrix SVGs. No runtime JS icon library. The app uses
`web/src/app/components/ui/Icon.tsx`, which applies SVGs as CSS masks and tints
them with `background-color`.

The primary app icon family is the curated GSV mask set in `/icons/<name>.svg`.
Existing app calls such as `<Icon name="computer" />` intentionally keep using
those curated masks.

The broader reference family is `doticons`, originally vendored from
[eduardconstantin/doticons@v0.9.0](https://github.com/eduardconstantin/doticons)
(MIT) and pruned to icons referenced by the web UI:

- 16-dot masters: `/icons/doticons/16/<name>.svg`
- 32-dot masters: `/icons/doticons/<name>.svg`

When the doticons family is used, `Icon` chooses the 16-dot master for rendered
sizes at `20px` and under, and the 32-dot master above that. `dotMatrix={16 |
32}` can force a master when a view needs exact control. A few 32-grid names are
not present in upstream's 16-grid folder, so those fall back to 32.

## Usage

- App usage: `<Icon name="folder" size={18} />`
- Doticons usage: `<Icon name="folder" family="doticons" size={18} />`
- Namespaced doticons usage: `<Icon name="doticons/file" size={18} />`
- Force doticons 16-grid: `<Icon name="folder" family="doticons" size={18} dotMatrix={16} />`

## object key → icon name → filename

| object key   | icon name | filename       |
| ------------ | --------- | -------------- |
| machines     | computer  | icons/computer.svg |
| machine      | computer  | icons/computer.svg |
| messengers   | chat      | icons/chat.svg     |
| discord      | discord   | icons/discord.svg  |
| telegram     | telegram  | icons/telegram.svg |
| integrations | weblink   | icons/weblink.svg  |
| mail         | gmail     | icons/gmail.svg    |
| linear       | list      | icons/list.svg     |
| applications | stars     | icons/stars.svg    |
| game         | stars     | icons/stars.svg    |
| scanner      | stars     | icons/stars.svg    |
| coach        | stars     | icons/stars.svg    |
| files        | folder    | icons/folder.svg   |
| settings     | cog       | icons/cog.svg      |
| satellite    | rss       | icons/rss.svg      |
| add          | plus      | icons/plus.svg     |
| library      | pencil    | icons/pencil.svg   |
| terminal     | terminal  | icons/terminal.svg |
| tabs         | bookmark  | icons/bookmark.svg |

Doticons aliases such as `computer -> box`, `plus -> circlePlus`, and `terminal
-> powershell` apply only when the caller explicitly selects the doticons family.

## Doticons Set

Only the active doticons subset remains available in source. Prefer explicit
doticons usage at the call site, and add the matching SVG asset when a new icon
is introduced.
