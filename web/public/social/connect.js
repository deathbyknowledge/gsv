const form = document.querySelector("form[data-profile]");
if (form instanceof HTMLFormElement) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const error = form.querySelector(".connect-error");
    const input = form.elements.namedItem("space");
    if (!(input instanceof HTMLInputElement) || !(error instanceof HTMLElement)) return;
    try {
      const value = input.value.trim();
      // A bare handle names a Ship on the operator's own domain; any other Ship needs its full address.
      const handle = value.replace(/^@/, "").toLowerCase();
      const domain = form.dataset.handleDomain;
      const isHandle = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(handle);
      if (isHandle && !domain) throw new Error("Enter your Ship’s full HTTPS address.");
      const destination = isHandle ? new URL(`https://${handle}.${domain}/`) : new URL(value.includes("://") ? value : `https://${value}`);
      if (destination.protocol !== "https:" || destination.username || destination.password || destination.pathname !== "/" || destination.search || destination.hash) {
        throw new Error(domain ? "Enter your handle, such as @alex, or your Ship’s full HTTPS address." : "Enter your Ship’s full HTTPS address.");
      }
      const profile = form.dataset.profile;
      if (!profile) throw new Error("This profile is unavailable.");
      destination.pathname = "/people";
      destination.searchParams.set("compose", profile);
      window.location.assign(destination.href);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Enter your handle.";
      error.hidden = false;
      input.focus();
    }
  });
}
