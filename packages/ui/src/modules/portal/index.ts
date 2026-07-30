import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";

/**
 * A web browser.
 *
 * Live web content cannot live inside WebGL, which the compositor already
 * knows — panels are DOM for exactly this reason. So a browser is an iframe
 * plus the chrome that makes an iframe feel like a browser: tabs that keep
 * their pages alive, an address bar, real back/forward, and bookmarks.
 *
 * The honest part is what stands between this and the open web. A browser
 * refuses to frame any document whose server sends `X-Frame-Options` or a CSP
 * `frame-ancestors`, and most large sites send one. No client-side code
 * defeats that — the enforcement lives in the browser, not the page.
 *
 * So there are two modes, and the shell says which one it's in:
 *
 *   - **proxied** (dev) — the host bridge serves the site from a local port
 *     with those headers stripped, and injects a reporter so in-page
 *     navigation updates the address bar. Effectively everything loads.
 *   - **direct** (production, or no bridge) — the iframe points straight at
 *     the site. Framable sites work; the rest render blank, and the pane says
 *     so rather than leaving you looking at nothing.
 *
 * Tabs keep one iframe each rather than swapping a single frame's src, because
 * a tab you switch away from and back to should still be where you left it.
 */

const BOOKMARKS = "/home/void/.bookmarks";
const HOME_KEY = "portal.home";
const DEFAULT_HOME = "https://en.wikipedia.org/wiki/Special:Random";
const MAX_TABS = 8;

interface Tab {
  id: number;
  /** Pages this tab has visited, for back and forward. */
  history: string[];
  index: number;
  title: string;
  frame: HTMLIFrameElement;
  /** Set once the bridge answers, so reload doesn't re-resolve every time. */
  proxied: boolean;
}

/**
 * Turn whatever was typed into a URL. A bare domain becomes https; anything
 * that isn't domain-shaped becomes a search, since that's what an address bar
 * is expected to do with prose.
 */
export function resolveQuery(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  // A single token containing a dot and no spaces is a hostname.
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(\/|$|:)/i.test(text)) {
    return `https://${text}`;
  }
  // DuckDuckGo's HTML endpoint — no JavaScript required, so it renders inside
  // a frame that a modern search page would not.
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`;
}

/** The bit of a URL worth showing on a tab. */
function labelFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

export const portal: VoidModule = {
  manifest: {
    id: "portal",
    name: "Portal",
    kind: "app",
    glyph: "◎",
    blurb: "a web browser, framed",
    singleton: false,
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineSetting({
      key: HOME_KEY,
      label: "the page Portal opens on",
      hint: "also what the home button goes to",
      kind: "custom",
      group: "Apps",
      order: 30,
      default: DEFAULT_HOME,
      render: (root, c) => {
        const input = document.createElement("input");
        input.className = "set-text";
        input.type = "text";
        input.spellcheck = false;
        input.value = c.state.get<string>(HOME_KEY, DEFAULT_HOME);
        const commit = () => c.state.set(HOME_KEY, input.value.trim() || DEFAULT_HOME);
        input.addEventListener("change", commit);
        input.addEventListener("blur", commit);
        root.appendChild(input);
      },
    });

    ctx.defineCommand({
      id: "portal.open",
      label: "browse the web",
      hint: "open a browser window",
      glyph: "◎",
      run: (c) => c.launch("portal"),
    });
  },

  launch(ctx: KernelContext, args?: LaunchArgs) {
    const startUrl =
      typeof args?.url === "string" && args.url
        ? resolveQuery(args.url)
        : ctx.state.get<string>(HOME_KEY, DEFAULT_HOME);

    ctx.openSurface({
      title: "portal",
      width: 900,
      height: 620,
      render: (root) => {
        root.className = "pt-root";

        /* ---------------- chrome ---------------- */

        const strip = document.createElement("div");
        strip.className = "pt-tabs";

        const bar = document.createElement("div");
        bar.className = "pt-bar";

        const mkBtn = (glyph: string, title: string) => {
          const b = document.createElement("button");
          b.className = "pt-btn";
          b.type = "button";
          b.textContent = glyph;
          b.title = title;
          return b;
        };

        const back = mkBtn("‹", "back");
        const fwd = mkBtn("›", "forward");
        const reload = mkBtn("↻", "reload");
        const homeBtn = mkBtn("⌂", "home");

        const address = document.createElement("input");
        address.className = "pt-url";
        address.type = "text";
        address.spellcheck = false;
        address.autocomplete = "off";
        address.placeholder = "address, or something to search for";

        const star = mkBtn("☆", "bookmark this page");
        const pop = document.createElement("a");
        pop.className = "pt-btn";
        pop.textContent = "↗";
        pop.title = "open in a real browser tab";
        pop.target = "_blank";
        pop.rel = "noopener noreferrer";

        bar.append(back, fwd, reload, homeBtn, address, star, pop);

        const stage = document.createElement("div");
        stage.className = "pt-stage";

        const marks = document.createElement("div");
        marks.className = "pt-marks";

        const note = document.createElement("div");
        note.className = "pt-note";

        root.append(strip, bar, marks, stage, note);

        /* ---------------- tabs ---------------- */

        const tabs: Tab[] = [];
        let active = 0;
        let nextId = 1;
        /** Null until the first navigation tells us whether a bridge exists. */
        let bridge: boolean | null = null;

        const current = (): Tab | undefined => tabs[active];
        const urlOf = (t: Tab): string => t.history[t.index] ?? "";

        const newTab = (url: string): Tab => {
          const frame = document.createElement("iframe");
          frame.className = "pt-frame";
          frame.setAttribute("title", "web content");
          // A framed page is untrusted third-party content. It may script and
          // navigate itself, but it must not reach into the shell's storage or
          // pop up windows over the void.
          frame.setAttribute(
            "sandbox",
            "allow-scripts allow-forms allow-same-origin allow-popups-to-escape-sandbox"
          );
          frame.hidden = true;
          stage.appendChild(frame);

          const tab: Tab = { id: nextId++, history: [], index: -1, title: "new tab", frame, proxied: false };
          tabs.push(tab);
          if (url) navigate(tab, url);
          return tab;
        };

        // The last tab has no close button (see paint), so this never empties
        // the list. Closing the *window* is the panel's own ✕ — a tab control
        // that sometimes closes the whole surface is a control you can't trust.
        const closeTab = (tab: Tab) => {
          const i = tabs.indexOf(tab);
          if (i < 0 || tabs.length <= 1) return;
          tab.frame.remove();
          tabs.splice(i, 1);
          active = Math.min(active, tabs.length - 1);
          paint();
        };

        /* ---------------- navigation ---------------- */

        /**
         * Point a tab at a URL, recording it in that tab's history.
         *
         * `push` is false when back/forward moved us — replaying a step must
         * not append a new one, or the stack grows every time you go back.
         */
        function navigate(tab: Tab, url: string, push = true): void {
          if (!url) return;
          if (push) {
            // Anything ahead of the cursor is discarded, as in every browser.
            tab.history = [...tab.history.slice(0, tab.index + 1), url];
            tab.index = tab.history.length - 1;
          }
          tab.title = labelFor(url);

          fetch("/__vs/browse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          })
            .then((r) => {
              if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
                throw new Error("no bridge");
              }
              return r.json();
            })
            .then((info: { framePort: number; path: string; error?: string }) => {
              if (info.error) throw new Error(info.error);
              bridge = true;
              tab.proxied = true;
              tab.frame.src = `http://localhost:${info.framePort}${info.path}`;
            })
            .catch(() => {
              // No host bridge: production, or a URL the proxy refused. Frame
              // it directly and be plain that most sites will decline.
              bridge = false;
              tab.proxied = false;
              tab.frame.src = url;
            })
            .finally(paint);

          paint();
        }

        const go = () => {
          const tab = current();
          if (!tab) return;
          const url = resolveQuery(address.value);
          if (url) navigate(tab, url);
        };

        back.addEventListener("click", () => {
          const t = current();
          if (t && t.index > 0) {
            t.index--;
            navigate(t, urlOf(t), false);
          }
        });
        fwd.addEventListener("click", () => {
          const t = current();
          if (t && t.index < t.history.length - 1) {
            t.index++;
            navigate(t, urlOf(t), false);
          }
        });
        reload.addEventListener("click", () => {
          const t = current();
          if (t) navigate(t, urlOf(t), false);
        });
        homeBtn.addEventListener("click", () => {
          const t = current();
          if (t) navigate(t, ctx.state.get<string>(HOME_KEY, DEFAULT_HOME));
        });
        address.addEventListener("keydown", (e) => {
          e.stopPropagation(); // the shell's global binds must not fire here
          if (e.key === "Enter") go();
        });

        /**
         * The proxied page reports its own navigation, which is the only way
         * the address bar can follow a link the user clicked inside a
         * cross-origin frame.
         */
        const onMessage = (e: MessageEvent) => {
          const data = e.data as { __voidshell?: string; url?: string; title?: string };
          if (data?.__voidshell !== "nav" || !data.url) return;
          const tab = tabs.find((t) => t.frame.contentWindow === e.source);
          if (!tab) return;
          if (urlOf(tab) === data.url) return; // already recorded
          tab.history = [...tab.history.slice(0, tab.index + 1), data.url];
          tab.index = tab.history.length - 1;
          tab.title = data.title?.trim() || labelFor(data.url);
          paint();
        };
        window.addEventListener("message", onMessage);

        /* ---------------- bookmarks ---------------- */

        // Kept as a file, not a store key, so they can be read, edited, piped
        // and grepped like anything else the system owns.
        const readMarks = (): { url: string; title: string }[] => {
          try {
            return ctx.fs
              .read(BOOKMARKS)
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#"))
              .map((l) => {
                const tab = l.indexOf("\t");
                return tab > 0
                  ? { url: l.slice(0, tab), title: l.slice(tab + 1) }
                  : { url: l, title: labelFor(l) };
              });
          } catch {
            return [];
          }
        };

        const writeMarks = (list: { url: string; title: string }[]) => {
          ctx.fs.write(
            BOOKMARKS,
            ["# voidshell bookmarks — url<tab>title", ...list.map((m) => `${m.url}\t${m.title}`)].join(
              "\n"
            )
          );
        };

        star.addEventListener("click", () => {
          const t = current();
          if (!t) return;
          const url = urlOf(t);
          if (!url) return;
          const list = readMarks();
          const existing = list.findIndex((m) => m.url === url);
          if (existing >= 0) {
            list.splice(existing, 1);
            ctx.notify("bookmark removed");
          } else {
            list.push({ url, title: t.title });
            ctx.notify(`bookmarked ${t.title}`, "good");
          }
          writeMarks(list);
          paint();
        });

        /* ---------------- painting ---------------- */

        function paint(): void {
          // tab strip
          strip.replaceChildren();
          tabs.forEach((t, i) => {
            const el = document.createElement("div");
            el.className = `pt-tab${i === active ? " on" : ""}`;
            const label = document.createElement("span");
            label.className = "pt-tab-label";
            label.textContent = t.title;
            label.title = urlOf(t);
            label.addEventListener("click", () => {
              active = i;
              paint();
            });
            el.appendChild(label);
            if (tabs.length > 1) {
              const x = document.createElement("button");
              x.className = "pt-tab-x";
              x.type = "button";
              x.textContent = "×";
              x.title = "close tab";
              x.addEventListener("click", (e) => {
                e.stopPropagation();
                closeTab(t);
              });
              el.appendChild(x);
            }
            strip.appendChild(el);
          });

          if (tabs.length < MAX_TABS) {
            const add = document.createElement("button");
            add.className = "pt-tab-add";
            add.type = "button";
            add.textContent = "+";
            add.title = "new tab";
            add.addEventListener("click", () => {
              newTab(ctx.state.get<string>(HOME_KEY, DEFAULT_HOME));
              active = tabs.length - 1;
              paint();
            });
            strip.appendChild(add);
          }

          // frames
          tabs.forEach((t, i) => (t.frame.hidden = i !== active));

          const t = current();
          const url = t ? urlOf(t) : "";
          if (document.activeElement !== address) address.value = url;
          pop.href = url || "#";

          back.disabled = !t || t.index <= 0;
          fwd.disabled = !t || t.index >= t.history.length - 1;

          const marked = readMarks().some((m) => m.url === url);
          star.textContent = marked ? "★" : "☆";
          star.classList.toggle("on", marked);

          // bookmark bar
          marks.replaceChildren();
          for (const m of readMarks().slice(0, 12)) {
            const b = document.createElement("button");
            b.className = "pt-mark";
            b.type = "button";
            b.textContent = m.title;
            b.title = m.url;
            b.addEventListener("click", () => {
              const tab = current();
              if (tab) navigate(tab, m.url);
            });
            marks.appendChild(b);
          }
          marks.hidden = marks.children.length === 0;

          // mode
          if (bridge === false) {
            note.className = "pt-note warn";
            note.textContent =
              "no host bridge — framing the site directly. Sites that send " +
              "X-Frame-Options or frame-ancestors (most large ones) will stay blank; " +
              "use ↗ to open those for real.";
          } else if (bridge === true) {
            note.className = "pt-note";
            note.textContent = `proxied through the host bridge · ${tabs.length} tab${
              tabs.length === 1 ? "" : "s"
            }`;
          } else {
            note.className = "pt-note";
            note.textContent = "connecting…";
          }
        }

        newTab(startUrl);
        active = 0;
        paint();
        address.focus();

        return () => {
          window.removeEventListener("message", onMessage);
          root.replaceChildren();
        };
      },
    });
  },
};
