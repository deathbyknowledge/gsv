// Copies the profile address. The button stays hidden when scripts or the clipboard are unavailable.
const button = document.querySelector("button.copy");
const status = document.querySelector(".copy-status");
if (button instanceof HTMLButtonElement && status && navigator.clipboard) {
  button.hidden = false;
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(button.dataset.copy ?? location.href).then(
      () => { status.textContent = "copied"; },
      () => { status.textContent = "Could not copy. Select the address from your browser instead."; },
    );
  });
}

// The wordmark glitches briefly every few seconds, as on ship.space.
const mark = document.querySelector(".wordmark");
if (mark && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  setInterval(() => {
    mark.classList.add("is-glitch");
    setTimeout(() => mark.classList.remove("is-glitch"), 90);
  }, 3200);
}

// Each hint opens on hover, focus, tap, Enter or Space, and Escape closes it. Like the design
// system tooltip, the bubble stays inside its row and its arrow points at the icon.
const rows = [...document.querySelectorAll("[data-info-row]")];
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const row of rows) {
    row.classList.remove("is-open");
    row.classList.add("is-dismissed");
    row.querySelector(".info")?.setAttribute("aria-expanded", "false");
  }
});
for (const row of rows) {
  const info = row.querySelector(".info");
  const bubble = row.querySelector(".info-bubble");
  if (!(row instanceof HTMLElement) || !(info instanceof HTMLElement) || !(bubble instanceof HTMLElement)) continue;
  const place = () => {
    const rowBox = row.getBoundingClientRect();
    const icon = info.getBoundingClientRect();
    const center = icon.left + icon.width / 2 - rowBox.left;
    const left = Math.max(0, Math.min(center - bubble.offsetWidth / 2, rowBox.width - bubble.offsetWidth));
    bubble.style.setProperty("--bubble-x", `${left}px`);
    bubble.style.setProperty("--arrow-x", `${center - left}px`);
  };
  const show = () => { row.classList.remove("is-dismissed"); place(); };
  const toggle = () => { show(); info.setAttribute("aria-expanded", String(row.classList.toggle("is-open"))); };
  info.setAttribute("aria-expanded", "false");
  info.addEventListener("pointerenter", show);
  info.addEventListener("focus", show);
  info.addEventListener("click", toggle);
  info.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
  document.addEventListener("pointerdown", (event) => { if (!(event.target instanceof Node) || !info.contains(event.target)) { row.classList.remove("is-open"); info.setAttribute("aria-expanded", "false"); } });
}
