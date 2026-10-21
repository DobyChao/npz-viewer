import { test as base, expect } from "@playwright/test";

// Run the same interaction suite against the native Rust bridge as well as the
// browser hub. The injected config is identical to a Tauri tab's init script.
export const test = base.extend({
  page: async ({ page }, use) => {
    const config = process.env.NPZVIEW_E2E_BRIDGE;
    if (config) {
      await page.addInitScript((value) => {
        (window as Window & { __NPZVIEW_DESKTOP__?: unknown }).__NPZVIEW_DESKTOP__ = value;
      }, JSON.parse(config));
    }
    await use(page);
  },
});

export { expect };
