export function AccountShell({
  children,
  eyebrow = "MANAGED GSV",
  icon = "/icons/stars.svg",
  stageClass = "",
  footer = "Your credentials and private GSV data stay out of third-party pages.",
}: {
  children: preact.ComponentChildren;
  eyebrow?: string;
  icon?: string;
  stageClass?: string;
  footer?: string;
}) {
  return (
    <main class="account-page">
      <div class="account-grid" aria-hidden="true" />
      <header class="account-header">
        <a class="account-brand" href="https://gsv.space" aria-label="GSV home">
          <img src="/brand/gsv-mark-white.svg" alt="" />
          <span>GSV</span>
        </a>
        <span class="account-product">PERSONAL INTELLIGENCE</span>
      </header>

      <section class={`account-stage${stageClass ? ` ${stageClass}` : ""}`} aria-live="polite">
        <div class="account-service-mark">
          <img src={icon} alt="" />
        </div>
        <p class="account-eyebrow">{eyebrow}</p>
        {children}
      </section>

      <footer class="account-footer">
        <span>accounts.gsv.space</span>
        <span>{footer}</span>
      </footer>
    </main>
  );
}

export function StatusCard({
  title,
  copy,
  tone = "neutral",
  children,
}: {
  title: string;
  copy: string;
  tone?: "neutral" | "warning" | "error" | "success";
  children?: preact.ComponentChildren;
}) {
  return (
    <div class={`account-card account-status-card account-tone-${tone}`}>
      <span class="account-status-light" aria-hidden="true" />
      <h1>{title}</h1>
      <p>{copy}</p>
      {children}
    </div>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "warning" | "error" | "success";
  children: preact.ComponentChildren;
}) {
  return <p class={`account-notice account-notice-${tone}`}>{children}</p>;
}

export function Progress({ label = "Working" }: { label?: string }) {
  return (
    <span class="account-progress" role="status">
      <span />
      <span />
      <span />
      <span class="account-sr-only">{label}</span>
    </span>
  );
}
