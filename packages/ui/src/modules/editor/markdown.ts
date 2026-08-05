/**
 * A small Markdown renderer.
 *
 * Deliberately hand-written rather than a dependency: the app ships with one
 * runtime dependency and a Markdown parser is not worth being the second, for
 * a feature whose job is to make a README readable in a window.
 *
 * It builds DOM nodes and sets `textContent`, never `innerHTML`. That is not
 * belt-and-braces — the files it renders come from /projects, which is a scan
 * of whatever is on the machine's disk, so "the input is trusted" is not a
 * claim anyone should make about it. Nothing here can produce an element the
 * renderer did not decide to create.
 *
 * Supported, in rough order of how often a real README needs it: headings,
 * fenced and indented code, lists, blockquotes, horizontal rules, tables,
 * paragraphs, and inline code / bold / italic / links.
 */

/** Inline spans, rendered into an existing parent. */
function renderInline(parent: HTMLElement, text: string): void {
  // One pass, longest markers first so `**` is never read as two `*`.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/;
  let rest = text;

  while (rest) {
    const m = pattern.exec(rest);
    if (!m || m.index === undefined) break;

    if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const token = m[0];

    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // Only http(s) becomes a link. `javascript:` in a README from a scanned
      // repository is exactly the case this refuses to render as clickable.
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement("a");
        a.textContent = label;
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(`${label} (${href})`));
      }
    } else {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    }

    rest = rest.slice(m.index + token.length);
  }

  if (rest) parent.appendChild(document.createTextNode(rest));
}

/** Render Markdown source into a detached element the caller mounts. */
export function renderMarkdown(source: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "md";

  const lines = source.split("\n");
  let i = 0;

  /** Paragraph accumulator: blank lines and block starts flush it. */
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    renderInline(p, para.join(" "));
    root.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. The info string (```ts) is kept as a label rather than
    // pretending to highlight something we don't parse.
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const pre = document.createElement("pre");
      pre.className = "md-code";
      if (fence[1].trim()) pre.dataset.lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      pre.textContent = body.join("\n");
      root.appendChild(pre);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const h = document.createElement(`h${heading[1].length}`);
      renderInline(h, heading[2]);
      root.appendChild(h);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushPara();
      root.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    // Table: a header row followed by a |---|---| separator.
    if (line.includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? "")) {
      flushPara();
      const table = document.createElement("table");
      table.className = "md-table";
      const cells = (row: string) =>
        row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

      const thead = document.createElement("tr");
      for (const c of cells(line)) {
        const th = document.createElement("th");
        renderInline(th, c);
        thead.appendChild(th);
      }
      table.appendChild(thead);
      i += 2;
      while (i < lines.length && lines[i].includes("|")) {
        const tr = document.createElement("tr");
        for (const c of cells(lines[i])) {
          const td = document.createElement("td");
          renderInline(td, c);
          tr.appendChild(td);
        }
        table.appendChild(tr);
        i++;
      }
      root.appendChild(table);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flushPara();
      const ordered = numbered.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      list.className = "md-list";
      while (i < lines.length) {
        const m = (ordered ? numbered : bullet).exec(lines[i]);
        if (!m) break;
        const li = document.createElement("li");
        // A task list is a list whose items start with a checkbox mark.
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[1]);
        if (task) {
          li.className = task[1] === " " ? "md-task" : "md-task done";
          renderInline(li, task[2]);
        } else {
          renderInline(li, m[1]);
        }
        list.appendChild(li);
        i++;
      }
      root.appendChild(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = document.createElement("blockquote");
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      renderInline(quote, body.join(" "));
      root.appendChild(quote);
      continue;
    }

    para.push(line.trim());
    i++;
  }

  flushPara();
  return root;
}
