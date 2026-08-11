import type { KernelContext } from "../../kernel/types";

/**
 * Which folder on your machine `/projects` is a view of.
 *
 * The mount used to be wherever the checkout happened to sit, which meant it
 * changed shape from machine to machine with nothing on screen to say so. The
 * path is now stated rather than inferred, and this is where you state it.
 *
 * The endpoint behind this exists **only in dev**, by the same construction as
 * the host bridge: `configureServer` never runs for a production build, so a
 * deployed voidshell has no bridge to its own disk and nothing to repoint. In
 * that case the control reports the root the bundle was frozen with and says
 * it can't be changed from here, rather than offering a text box that silently
 * does nothing.
 */

/** Mirrors `ROOT_ENDPOINT` in packages/ui/plugins/projects.ts. */
const ROOT_ENDPOINT = "/__vs/projects/root";

interface RootReport {
  root: string;
  source: "env" | "config" | "default";
  exists: boolean;
  configPath: string;
  projects: number;
  settable: boolean;
}

/** Why the mount is where it is, in words rather than an enum. */
function explain(r: RootReport): string {
  if (r.source === "env") return "set by VOIDSHELL_PROJECTS_ROOT";
  if (r.source === "config") return "set in voidshell.local.json";
  return "defaulting to the folder holding this checkout";
}

async function fetchRoot(): Promise<RootReport | null> {
  try {
    const res = await fetch(ROOT_ENDPOINT);
    if (!res.ok) return null;
    return (await res.json()) as RootReport;
  } catch {
    // No bridge — a production build, or the dev server went away.
    return null;
  }
}

export function renderProjectsRoot(root: HTMLElement, ctx: KernelContext): () => void {
  let dead = false;

  root.replaceChildren();
  root.className = "ws-projroot";

  const status = document.createElement("div");
  status.className = "ws-projroot-status";
  status.textContent = "checking…";

  const row = document.createElement("div");
  row.className = "ws-projroot-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ws-projroot-input";
  input.spellcheck = false;
  input.placeholder = "~/projects";
  input.setAttribute("aria-label", "Projects folder");

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "ws-projroot-apply";
  apply.textContent = "Use this";

  row.append(input, apply);
  root.append(status, row);

  // The shell binds space and Escape globally; a text field has to win.
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") apply.click();
  });

  const paint = (r: RootReport | null) => {
    if (dead) return;
    if (!r) {
      row.hidden = true;
      status.textContent =
        "Fixed at build time — /projects was frozen into this build and can only " +
        "be changed by rebuilding with VOIDSHELL_PROJECTS_ROOT set.";
      return;
    }
    row.hidden = false;
    if (document.activeElement !== input) input.value = r.root;
    const found = r.exists
      ? `${r.projects} project${r.projects === 1 ? "" : "s"}`
      : "does not exist";
    status.textContent = `${r.root} — ${found}, ${explain(r)}`;
    status.classList.toggle("bad", !r.exists || r.projects === 0);
  };

  void fetchRoot().then(paint);

  apply.addEventListener("click", () => {
    const next = input.value.trim();
    if (!next) return;
    apply.disabled = true;
    void (async () => {
      try {
        const res = await fetch(ROOT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: next }),
        });
        const body = (await res.json()) as RootReport & { error?: string };
        if (!res.ok) {
          ctx.notify(body.error ?? "could not use that folder", "warn");
          return;
        }
        paint(body);
        // /projects is mounted once, during boot, so the tree on screen is
        // still the old one. Rather than pretend otherwise, say what has to
        // happen and offer to do it — a warning without a button is a bug.
        ctx.notify(`/projects now points at ${body.root}`, {
          kind: "good",
          action: { label: "Reload", run: () => location.reload() },
          sticky: true,
        });
      } catch {
        ctx.notify("the dev server did not answer", "warn");
      } finally {
        if (!dead) apply.disabled = false;
      }
    })();
  });

  return () => {
    dead = true;
  };
}
