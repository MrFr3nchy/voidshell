import { api, ApiError } from "../kernel/apiWorkspace";
import type { WorkspaceSnapshot } from "../kernel/persistence";

/**
 * The screen between you and the void.
 *
 * This runs before there is a kernel, a compositor or a toast system, which is
 * the whole point: the shell must not exist until there is an account to hang
 * it on. So it owns its own DOM and reports its own errors, inline beside the
 * field that caused them — which is where an error about a mistyped key wants
 * to be anyway, rather than in a corner of a screen you aren't looking at.
 */

/** Verbatim from the plan, and deliberately not softened. */
const WARNING_TITLE = "This is a toy account system. Treat it that way.";
const WARNING_BODY = [
  "Your key is your only credential — there is no password, no email, and no recovery. " +
    "Save it somewhere now; if you lose it, this dashboard is gone permanently and nobody can restore it.",
  "Anyone who obtains your key has full access to your dashboard. Data is stored unencrypted " +
    "on a single server with no guarantees. Do not put anything private, sensitive, or valuable in here.",
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/**
 * A way into the void, with or without an account behind it.
 *
 * `guest` is the difference between a dashboard that is saved and one that
 * lives in the tab, and it is carried out of here rather than inferred later
 * because this screen is the only place that knows which door was used.
 */
export interface Session {
  workspace: WorkspaceSnapshot;
  guest: boolean;
}

/** An empty dashboard, for a session that starts from nothing. */
const EMPTY: WorkspaceSnapshot = { state: {}, fs: null };

/**
 * Blocks until there is a session, and answers with the dashboard behind it.
 *
 * Resolves exactly once. Everything the shell needs to boot is in the return
 * value, so the caller never has to ask the server a second time.
 */
export function runLockScreen(initial?: { unreachable: boolean }): Promise<Session> {
  return new Promise((resolve) => {
    const veil = el("div", "lock-veil");
    const card = el("div", "lock-card");
    veil.appendChild(card);
    document.body.appendChild(veil);
    requestAnimationFrame(() => veil.classList.add("up"));

    const done = (workspace: WorkspaceSnapshot, guest = false) => {
      veil.classList.remove("up");
      window.setTimeout(() => veil.remove(), 420);
      resolve({ workspace, guest });
    };

    /**
     * The way in for somebody who has not decided yet.
     *
     * Offered on both screens, and for different reasons. On the locked one it
     * is the answer to being asked for a credential before being shown what it
     * unlocks. On the unreachable one it is the difference between a dead page
     * and a working shell — nothing behind this screen needs the server except
     * the saving, and refusing to boot over that means an outage costs the user
     * the whole OS rather than one of its properties.
     */
    const guestOffer = (label: string, hint: string) => {
      const wrap = el("div", "lock-guest");
      const btn = el("button", "lock-btn lock-btn-ghost", label);
      btn.type = "button";
      btn.onclick = () => done(EMPTY, true);
      wrap.append(btn, el("div", "lock-guest-hint", hint));
      return wrap;
    };

    /* ---------------- the server is not answering ---------------- */

    const renderUnreachable = (detail: string) => {
      card.replaceChildren();
      card.append(
        el("div", "lock-title", "can't reach the server"),
        el(
          "div",
          "lock-sub",
          "Your dashboard is fine — this machine just can't get to it right now. " +
            "Nothing has been lost."
        ),
        el("div", "lock-detail", detail)
      );

      const retry = el("button", "lock-btn lock-btn-primary", "try again");
      retry.onclick = () => {
        retry.disabled = true;
        retry.textContent = "checking…";
        void probe();
      };
      card.appendChild(retry);
      card.appendChild(
        guestOffer(
          "go in without it",
          "The whole shell runs from here — only the saving needs the server. " +
            "Anything you do is gone when the tab closes."
        )
      );
    };

    /**
     * A failed session check is two different problems wearing the same coat.
     * A 401 means "sign in"; anything else means the server is down, and
     * showing a lock screen for that teaches people their key stopped working.
     */
    const probe = async () => {
      try {
        const { workspace } = await api.session();
        done(workspace);
      } catch (err) {
        if (err instanceof ApiError && !err.offline) renderLocked();
        else renderUnreachable(err instanceof Error ? err.message : String(err));
      }
    };

    /* ---------------- the key you already have ---------------- */

    const renderLocked = () => {
      card.replaceChildren();
      card.append(
        el("div", "lock-title", "voidshell"),
        el("div", "lock-sub", "Enter your key, or create a new dashboard.")
      );

      const form = el("form", "lock-form");
      const input = el("input", "lock-input");
      input.type = "text";
      input.placeholder = "four-words-like-this";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.autocapitalize = "off";

      const error = el("div", "lock-error");
      error.hidden = true;

      const submit = el("button", "lock-btn lock-btn-primary", "unlock");
      submit.type = "submit";

      form.append(input, submit);
      card.append(form, error);

      const fail = (message: string) => {
        error.textContent = message;
        error.hidden = false;
        input.classList.add("is-wrong");
        window.setTimeout(() => input.classList.remove("is-wrong"), 600);
      };

      form.onsubmit = async (e) => {
        e.preventDefault();
        const key = input.value.trim();
        if (!key) return;
        submit.disabled = true;
        input.disabled = true;
        error.hidden = true;
        submit.textContent = "unlocking…";
        try {
          await api.signin(key);
          const { workspace } = await api.session();
          done(workspace);
        } catch (err) {
          submit.disabled = false;
          input.disabled = false;
          submit.textContent = "unlock";
          if (err instanceof ApiError && err.offline) {
            fail("Can't reach the server. Your key is probably fine — try again in a moment.");
          } else if (err instanceof ApiError && err.status === 429) {
            fail("Too many attempts. Wait a few minutes before trying again.");
          } else {
            fail("That key doesn't match a dashboard.");
          }
          input.select();
        }
      };

      // Pasting a key should just work, including the trailing newline that
      // comes with copying a line out of a notes app.
      input.addEventListener("paste", (e) => {
        const text = e.clipboardData?.getData("text");
        if (!text) return;
        e.preventDefault();
        input.value = text.trim();
      });

      const create = el("button", "lock-btn lock-btn-ghost", "create a new dashboard");
      create.type = "button";
      create.onclick = async () => {
        create.disabled = true;
        create.textContent = "creating…";
        try {
          const { key } = await api.signup();
          renderNewKey(key);
        } catch (err) {
          create.disabled = false;
          create.textContent = "create a new dashboard";
          fail(
            err instanceof ApiError && err.offline
              ? "Can't reach the server."
              : "Couldn't create a dashboard. Try again."
          );
        }
      };
      card.appendChild(create);
      card.appendChild(
        guestOffer(
          "look around first",
          "A real session with nothing behind it \u2014 every app, every window, " +
            "your own files. It just isn\u2019t saved when the tab closes."
        )
      );
      card.appendChild(dismissibleWarning());

      input.focus();
    };

    /* ---------------- the key you have exactly once ---------------- */

    /**
     * The server keeps only sha256(key), so this render is the single moment
     * the plaintext exists anywhere but the user's own screen. Hence the
     * checkbox: it isn't ceremony, it's the last chance to notice.
     */
    const renderNewKey = (key: string) => {
      card.replaceChildren();
      card.append(
        el("div", "lock-title", "your key"),
        el("div", "lock-sub", "Write this down before you continue. You will not see it again.")
      );

      const keyRow = el("div", "lock-keyrow");
      const keyText = el("code", "lock-key", key);
      const copy = el("button", "lock-btn lock-btn-ghost", "copy");
      copy.type = "button";
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(key);
          copy.textContent = "copied";
        } catch {
          // Clipboard access can be refused outright. Selecting the text is a
          // worse experience than a copy button, and a much better one than a
          // button that silently does nothing.
          const range = document.createRange();
          range.selectNodeContents(keyText);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          copy.textContent = "select & copy";
        }
        window.setTimeout(() => (copy.textContent = "copy"), 2200);
      };
      keyRow.append(keyText, copy);
      card.appendChild(keyRow);

      card.appendChild(warningBlock());

      const confirmRow = el("label", "lock-confirm");
      const box = el("input");
      box.type = "checkbox";
      const enter = el("button", "lock-btn lock-btn-primary", "enter the void");
      enter.type = "button";
      enter.disabled = true;
      confirmRow.append(box, el("span", undefined, "I've saved this key somewhere safe."));
      box.onchange = () => (enter.disabled = !box.checked);

      enter.onclick = async () => {
        enter.disabled = true;
        enter.textContent = "entering…";
        try {
          // signup already set the cookie; this is just fetching the (empty)
          // dashboard so the caller gets the same shape either way.
          const { workspace } = await api.session();
          done(workspace);
        } catch {
          done({ state: {}, fs: null });
        }
      };

      card.append(confirmRow, enter);
    };

    const warningBlock = () => {
      const box = el("div", "lock-warn");
      box.appendChild(el("div", "lock-warn-title", WARNING_TITLE));
      for (const line of WARNING_BODY) box.appendChild(el("p", undefined, line));
      return box;
    };

    /**
     * The same warning, dismissible, for people who have already read it.
     *
     * Dismissal is remembered in memory only — there is nowhere else to put it
     * now, and a warning that reappears occasionally is the right failure
     * direction for this one.
     */
    const dismissibleWarning = () => {
      const wrap = el("div", "lock-warn is-dismissible");
      if (sessionDismissed) {
        const show = el("button", "lock-warn-toggle", "what is this?");
        show.type = "button";
        show.onclick = () => {
          sessionDismissed = false;
          wrap.replaceWith(dismissibleWarning());
        };
        wrap.appendChild(show);
        return wrap;
      }
      wrap.appendChild(el("div", "lock-warn-title", WARNING_TITLE));
      for (const line of WARNING_BODY) wrap.appendChild(el("p", undefined, line));
      const hide = el("button", "lock-warn-toggle", "dismiss");
      hide.type = "button";
      hide.onclick = () => {
        sessionDismissed = true;
        wrap.replaceWith(dismissibleWarning());
      };
      wrap.appendChild(hide);
      return wrap;
    };

    if (initial?.unreachable) renderUnreachable("the session check did not complete");
    else renderLocked();
  });
}

/** Survives a signout within one page load; not persisted anywhere. */
let sessionDismissed = false;
