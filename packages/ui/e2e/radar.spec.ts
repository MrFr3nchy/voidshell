import { test, expect } from "@playwright/test";

type VoidHandle = {
  kernel: { launch: (id: string) => unknown };
  compositor: {
    spawnStation: (kind: string, name?: string) => string;
    listStations: () => { id: string }[];
  };
};

declare global {
  interface Window {
    voidshell?: VoidHandle;
  }
}

test("spatial radar renders the layout and toggles with the keyboard", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.voidshell), null, {
    timeout: 45_000,
  });

  const radar = page.locator(".vs-radar canvas");
  await expect(radar).toBeVisible();

  // Populate the void: a few windows and a station to found blips.
  await page.evaluate(() => {
    const v = window.voidshell!;
    for (const id of ["notes", "calendar", "monitor", "vitals"]) {
      try {
        v.kernel.launch(id);
      } catch {
        /* not every build registers every app */
      }
    }
    v.compositor.spawnStation("relay", "radar-probe");
    v.compositor.spawnStation("beacon", "far-mark");
  });
  await page.waitForTimeout(1500);

  const stationCount = await page.evaluate(
    () => window.voidshell!.compositor.listStations().length
  );
  expect(stationCount).toBeGreaterThanOrEqual(2);

  // The radar canvas should be actively drawing — rings, the view cone, blips.
  const painted = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".vs-radar canvas");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(500);

  await page.screenshot({ path: "e2e/screens/radar.png" });

  // Cmd/Ctrl+Shift+M hides it, and again brings it back. Drop focus out of any
  // panel input a launched app may have grabbed so the keystroke reaches the
  // window-level binding cleanly.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".vs-radar")).toBeHidden();
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".vs-radar")).toBeVisible();

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
