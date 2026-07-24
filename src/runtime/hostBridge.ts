/**
 * Client for the host bridge (see plugins/host.ts).
 *
 * The bridge only exists while the Vite dev server is running. In a deployed
 * build every call here 404s, which is the correct and only safe behaviour —
 * a static site on someone else's machine must not be able to run commands.
 * Callers get a clear message rather than a silent failure.
 */

const EXEC = "/__vs/exec";
const JOBS = "/__vs/jobs";
const KILL = "/__vs/kill/";

export type Printer = (kind: string, text: string) => void;

export interface HostJob {
  id: string;
  cmd: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  port: number | null;
}

const NO_BRIDGE =
  "no host bridge — commands only run when voidshell is served by `npm run dev`";

/**
 * Parse a bridge response, treating "not actually the bridge" as absence.
 *
 * A 404 is the obvious case, but a static host with SPA fallback answers every
 * unknown path with index.html and a 200 — so trusting the status alone yields
 * a JSON parse error instead of a usable message.
 */
async function bridgeJson(r: Response): Promise<any> {
  const type = r.headers.get("content-type") ?? "";
  if (r.status === 404 || !type.includes("application/json")) {
    throw new Error(NO_BRIDGE);
  }
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `host error ${r.status}`);
  return body;
}

/** Map a VFS path back to a path the host understands, relative to its root. */
function hostCwd(vfsCwd: string): string {
  // /projects/<name>/... is a mount of the host's project root. The result must
  // stay *relative* — a leading slash would make path.resolve on the host treat
  // it as absolute and land outside the sandbox.
  if (vfsCwd.startsWith("/projects")) {
    return vfsCwd.slice("/projects".length).replace(/^\/+/, "") || ".";
  }
  // Anything else is virtual and has no host equivalent; use the root.
  return ".";
}

export function hostExec(
  command: string,
  vfsCwd: string,
  print: Printer,
  onPort?: (port: number, jobId: string) => void
): void {
  const cwd = hostCwd(vfsCwd);

  fetch(EXEC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: command, cwd }),
  })
    .then((r) => bridgeJson(r) as Promise<{ id: string; cwd: string }>)
    .then(({ id, cwd: realCwd }) => {
      print("muted", `[${id}] ${command}   (${realCwd})`);
      let announced = false;

      const es = new EventSource(`${EXEC}/${id}`);
      es.onmessage = (e) => {
        const line = JSON.parse(e.data) as { kind: string; text: string };
        // Child output arrives in chunks, not lines; split so the log reads right.
        for (const part of line.text.replace(/\r/g, "").split("\n")) {
          if (part.length) print(line.kind === "exit" ? "muted" : line.kind, part);
        }
        // Offer the app panel the first time a served URL shows up.
        if (!announced && onPort) {
          const m = line.text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/);
          if (m) {
            announced = true;
            const port = Number(m[1]);
            print("muted", `↗ serving on :${port} — opening app panel`);
            onPort(port, id);
          }
        }
      };
      es.addEventListener("done", () => es.close());
      es.onerror = () => es.close();
    })
    .catch((err) => print("warn", err instanceof Error ? err.message : String(err)));
}

export function hostJobs(print: Printer): void {
  fetch(JOBS)
    .then((r) => bridgeJson(r) as Promise<HostJob[]>)
    .then((list) => {
      if (!list.length) return print("muted", "no jobs");
      for (const j of list) {
        const port = j.port ? ` :${j.port}` : "";
        const code = j.status === "exited" ? ` (${j.exitCode})` : "";
        print("out", `${j.id}  ${j.status}${code}${port}  ${j.cmd}`);
      }
    })
    .catch((err) => print("warn", err instanceof Error ? err.message : String(err)));
}

export function hostKill(id: string, print: Printer): void {
  fetch(KILL + id, { method: "POST" })
    .then(async (r) => {
      if (r.status === 404) throw new Error(`no such job: ${id}`);
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
        throw new Error(NO_BRIDGE);
      }
      print("muted", `killed ${id}`);
    })
    .catch((err) => print("warn", err instanceof Error ? err.message : String(err)));
}
