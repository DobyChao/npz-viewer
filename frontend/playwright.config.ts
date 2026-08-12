import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.NPZVIEW_DEV_PORT ?? 5273);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // 127.0.0.1 rather than localhost: Vite binds IPv4 only, and the health probe
    // would otherwise try ::1 first and spawn a second, port-conflicting server.
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
