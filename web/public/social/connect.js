const form = document.querySelector("form[data-profile]");
if (form instanceof HTMLFormElement) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const error = form.querySelector(".connect-error");
    const input = form.elements.namedItem("space");
    if (!(input instanceof HTMLInputElement) || !(error instanceof HTMLElement)) return;
    try {
      const value = input.value.trim();
      const destination = new URL(value.includes("://") ? value : `https://${value}`);
      if (destination.protocol !== "https:" || destination.username || destination.password || destination.pathname !== "/" || destination.search || destination.hash) {
        throw new Error("Enter the HTTPS address of your own GSV, without a path.");
      }
      const profile = form.dataset.profile;
      if (!profile) throw new Error("This profile is unavailable.");
      destination.pathname = "/people";
      destination.searchParams.set("compose", profile);
      window.location.assign(destination.href);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Enter your GSV address.";
      error.hidden = false;
      input.focus();
    }
  });
}
