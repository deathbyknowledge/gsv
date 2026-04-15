import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

type View = "home" | "details";

function readUrlState(): { view: View; count: number; note: string } {
  const url = new URL(window.location.href);
  const view = url.searchParams.get("view") === "details" ? "details" : "home";
  const count = Number.parseInt(url.searchParams.get("count") ?? "3", 10);
  const note = url.searchParams.get("note") ?? "SPAs fit the new app backend model.";
  return {
    view,
    count: Number.isFinite(count) ? count : 3,
    note,
  };
}

function writeUrlState(view: View, count: number, note: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  url.searchParams.set("count", String(count));
  if (note.trim()) {
    url.searchParams.set("note", note);
  } else {
    url.searchParams.delete("note");
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function App() {
  const initial = readUrlState();
  const [view, setView] = useState<View>(initial.view);
  const [count, setCount] = useState(initial.count);
  const [note, setNote] = useState(initial.note);

  useEffect(() => {
    writeUrlState(view, count, note);
  }, [view, count, note]);

  const samples = useMemo(
    () =>
      Array.from({ length: Math.max(1, Math.min(8, count)) }, (_, index) => ({
        id: index + 1,
        label: `Tile ${index + 1}`,
      })),
    [count],
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "28px",
      }}
    >
      <div
        style={{
          maxWidth: "920px",
          margin: "0 auto",
          background: "var(--panel)",
          border: "1px solid var(--edge)",
          boxShadow: "0 18px 50px rgba(31, 41, 55, 0.08)",
        }}
      >
        <header
          style={{
            padding: "22px 24px",
            borderBottom: "1px solid var(--edge)",
            display: "flex",
            justifyContent: "space-between",
            gap: "16px",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--muted)" }}>
              Preact TSX proof
            </div>
            <h1 style={{ margin: "8px 0 0", fontSize: "30px", lineHeight: 1.1 }}>Preact Lab</h1>
          </div>
          <nav style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={() => setView("home")}
              style={navButton(view === "home")}
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => setView("details")}
              style={navButton(view === "details")}
            >
              Details
            </button>
          </nav>
        </header>

        <main
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.7fr) minmax(280px, 1fr)",
          }}
        >
          <section style={{ padding: "24px", borderRight: "1px solid var(--edge)" }}>
            {view === "home" ? (
              <>
                <h2 style={{ marginTop: 0 }}>Stateful without reloads</h2>
                <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
                  This app is a tiny TSX SPA. View changes and local state mutate the URL without a
                  document reload, which is the direction package apps should take on the new app backend model.
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                    gap: "12px",
                    marginTop: "20px",
                  }}
                >
                  {samples.map((sample) => (
                    <div
                      key={sample.id}
                      style={{
                        padding: "18px",
                        border: "1px solid var(--edge)",
                        background: "var(--accent-soft)",
                      }}
                    >
                      <div style={{ fontSize: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Sample
                      </div>
                      <div style={{ marginTop: "8px", fontSize: "20px", fontWeight: 600 }}>{sample.label}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 style={{ marginTop: 0 }}>URL-synced state</h2>
                <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
                  The counter and note are mirrored into the query string. Refreshing the window should restore them.
                </p>
                <div
                  style={{
                    marginTop: "18px",
                    padding: "18px",
                    border: "1px solid var(--edge)",
                    background: "#fcfaf4",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {window.location.pathname}
                  {window.location.search}
                </div>
              </>
            )}
          </section>

          <aside style={{ padding: "24px" }}>
            <h2 style={{ marginTop: 0 }}>Controls</h2>
            <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
              <button type="button" onClick={() => setCount((value) => Math.max(1, value - 1))} style={actionButton()}>
                -1
              </button>
              <button type="button" onClick={() => setCount((value) => value + 1)} style={actionButton()}>
                +1
              </button>
            </div>
            <div style={{ marginBottom: "16px", color: "var(--muted)" }}>Tile count: {count}</div>
            <label style={{ display: "block", fontSize: "13px", color: "var(--muted)", marginBottom: "8px" }}>
              Note
            </label>
            <input
              value={note}
              onInput={(event) => setNote((event.currentTarget as HTMLInputElement).value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "1px solid var(--edge)",
                background: "#fff",
                color: "var(--ink)",
              }}
            />
            <div
              style={{
                marginTop: "18px",
                padding: "16px",
                border: "1px solid var(--edge)",
                background: "#fff",
              }}
            >
              <div style={{ fontSize: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Current note
              </div>
              <p style={{ marginBottom: 0, lineHeight: 1.6 }}>{note || "No note set."}</p>
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

function navButton(active: boolean) {
  return {
    padding: "10px 14px",
    border: "1px solid var(--edge)",
    background: active ? "var(--accent)" : "#fff",
    color: active ? "#f8fffe" : "var(--ink)",
    cursor: "pointer",
  } as const;
}

function actionButton() {
  return {
    padding: "10px 14px",
    border: "1px solid var(--edge)",
    background: "#fff",
    color: "var(--ink)",
    cursor: "pointer",
  } as const;
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("Preact Lab root element is missing");
}

render(<App />, root);
