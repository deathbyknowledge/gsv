# GSV TUI web preview

This is the browser backend for the shared GSV TUI core. It uses Ratzilla's
WebGL2 backend for cell rendering and a native textarea bridge for Unicode
input, IME composition, paste, and browser shortcut suppression.

The preview intentionally uses local example responses. The production browser
transport remains owned by the existing web gateway service; the next
integration step is to route core effects through that authenticated client.

Run it from the repository root:

    npm run tui:dev --workspace web

This requires Trunk 0.21 or newer. If `trunk --version` is unavailable, install
one of the prebuilt binaries from the
[official Trunk releases](https://github.com/trunk-rs/trunk/releases).

The native preview needs no account:

    cd host
    cargo run -p gsv -- tui --demo
