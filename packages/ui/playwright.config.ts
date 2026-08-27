import { defineConfig, devices } from "@playwright/test";

/**
 * Boots the real Vite dev server and drives a WebGL-backed Chromium so the
 * Three-rendered world (stations included) is what actually gets exercised.
 * SwiftShader keeps that working on a headless box with no GPU.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
  ],
  webServer: {
    // Guest mode skips the account API the dev server has no backend for, so
    // boot reaches a live compositor instead of parking on the lock screen.
    command: "npm run dev",
    env: { VITE_VOIDSHELL_GUEST: "1" },
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
