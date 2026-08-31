# How GSV works

This folder contains a city-like map of GSV. It is made for people who want to
understand the project before they know its code or its special words.

The map runs only on your computer. It does not connect to a GSV home, open
private user information, or change any files.

## Open the map

From the main GSV folder, run:

```bash
npm run architecture:explore
```

Then open `http://127.0.0.1:4179` in a browser.

To use a different port, set `GSV_ARCHITECTURE_PORT` before starting it.

## What the city means

Each building is one large part of GSV with one clear job. Its lights are the
smaller parts inside it. Buildings and smaller parts keep their real project
names; a short plain-English line beside each name says what it does.

- Color puts buildings that work closely together into groups.
- Shape gives a visual clue about the kind of job.
- Size is chosen for the drawing. It does not mean more code, more work, better
  health, or greater importance.
- An arrow shows something moving in one direction.
- A dashed line shows that two places follow the same rules. It has no arrow
  because neither place is telling the other what to do.

Open **Guide** in the map for the full color, shape, and line key.

## Use the map

- Drag to turn it.
- Scroll, or use `+` and `-`, to zoom.
- Pick a building to learn its job and the one rule it must never break.
- Pick a light on a building to learn about that smaller part.
- Use **Places**, **About**, **Story**, or **Guide** to open one extra view at a
  time.
- Change the four buttons above the map to see how work moves, who handles it,
  what keeps it safe, or what it remembers.
- Open **Story** to follow one familiar event from beginning to end.
- Press `/` or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> to search by name or job.
- Open **Code** inside a building's explanation only when you want exact file,
  note, and check locations.

## How the explanations stay honest

The friendly words and the code facts are kept in separate files:

- `architecture.mjs` records the exact parts, connections, stories, and code
  locations.
- `plain-language.mjs` gives every one of those facts a simple explanation.
- `atlas-meta.mjs` chooses the groups, colors, shapes, positions, and extra
  safety notes.

The simple wording never replaces the code facts. It sits on top of them. The
**Code** view keeps the exact paths available for anyone who wants to check an
explanation against the project.

After changing the map, run:

```bash
npm run architecture:test
```

These checks catch missing parts, broken story steps, wrong file paths, missing
plain-language explanations, specialist words in the main copy, and accidental
links to the normal GSV website.

The small browser server exposes only the files needed by this map. It does not
offer a way to browse arbitrary project files.

## What this map does not show

- Whether a running GSV is healthy right now
- A real user's agents, settings, messages, or files
- A measurement of folder size or line count
- Controls for changing code or putting GSV online
