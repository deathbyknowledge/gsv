# GSV TUI web preview

This is the browser backend for the shared GSV TUI core. It uses Ratzilla's
WebGL2 backend for cell rendering and a native textarea bridge for Unicode
input, IME composition, paste, and browser shortcut suppression.

The native client adopts the user's terminal palette; this browser surface uses
the curated GSV palette because it has no host terminal theme. Both render the
same `principal@ship $` prompt grammar, styled Markdown, inspectable links, and
canonical media artifacts. Press `Alt+M` to switch an assistant response
between rendered Markdown and its source. Type `show me Markdown and media` in
the demo to exercise the rich-content path.

The preview intentionally uses local example responses. The production browser
transport remains owned by the existing web gateway service; the next
integration step is to route core effects through that authenticated client.
Media currently has a faithful textual artifact view (kind, name, MIME type,
size, duration, source, and transcription). Pixel previews belong in a backend
that can resolve and own the resource body rather than in the shared cell
renderer.

Run it from the repository root:

    npm run tui:dev --workspace web

This requires Trunk 0.21 or newer. If `trunk --version` is unavailable, install
one of the prebuilt binaries from the
[official Trunk releases](https://github.com/trunk-rs/trunk/releases).

The native preview needs no account:

    cd host
    cargo run -p gsv -- tui --demo
