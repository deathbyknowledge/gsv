<template>
  <div class="nav-title">
    <a href="https://gsv.space" class="nav-title-gsv">GSV</a>
    <a href="https://docs.gsv.space" class="nav-title-docs">documentation</a>
  </div>
</template>

<style scoped>
.nav-title {
  display: flex;
  align-items: baseline;
  gap: 0.15em;
  font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}

.nav-title-gsv {
  color: var(--vp-c-brand-1);
  text-decoration: none;
  letter-spacing: -0.01em;
}

.nav-title-gsv:hover {
  color: var(--vp-c-brand-2);
}

.nav-title-docs {
  color: var(--vp-c-text-2);
  text-decoration: none;
  font-weight: 500;
  letter-spacing: -0.01em;
}

.nav-title-docs:hover {
  color: var(--vp-c-text-1);
}
</style>
