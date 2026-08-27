import { test, expect } from "@playwright/test";

/** The station kinds added on top of the original rock / giant / ring. */
const NEW_KINDS = ["beacon", "garden", "forge", "relay"] as const;

type VoidHandle = {
  compositor: {
    spawnStation: (kind: string, name?: string) => string;
    travelTo: (id: string) => void;
    listStations: () => { id: string; kind: string; name: string }[];
    destroyStation: (id: string) => void;
  };
};

declare global {
  interface Window {
    voidshell?: VoidHandle;
  }
}

test("new stations found, travelled to, and animating without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");

  // Boot resolves the dev handle once the kernel and compositor are live.
  await page.waitForFunction(() => Boolean(window.voidshell), null, {
    timeout: 45_000,
  });

  for (const kind of NEW_KINDS) {
    const id = await page.evaluate((k) => {
      const v = window.voidshell!;
      const sid = v.compositor.spawnStation(k, `test-${k}`);
      v.compositor.travelTo(sid);
      return sid;
    }, kind);

    // Let travel settle and a few dozen animation frames run.
    await page.waitForTimeout(2500);

    const kinds = await page.evaluate(() =>
      window.voidshell!.compositor.listStations().map((s) => s.kind)
    );
    expect(kinds).toContain(kind);

    await page.screenshot({ path: `e2e/screens/${kind}.png` });

    await page.evaluate((sid) => window.voidshell!.compositor.destroyStation(sid), id);
  }

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
