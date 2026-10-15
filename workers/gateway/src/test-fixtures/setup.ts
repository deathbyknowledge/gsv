import { afterAll, vi } from "vitest";

// Cloudflare resolves the Worker module for DO RPCs, including background delivery.
// Let pending resolutions finish before Vitest closes its module runner.
afterAll(() => vi.dynamicImportSettled());
