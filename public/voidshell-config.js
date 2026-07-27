/*
 * voidshell config client.
 *
 * Drop this into a project that runs as a voidshell app and read configuration
 * the shell holds for you:
 *
 *   <script src="/voidshell-config.js"></script>
 *   const key = await voidshellConfig.get("ANTHROPIC_API_KEY");
 *
 * Values come from /home/void/.keys/<app-id>.env inside the shell's own
 * filesystem, editable in its editor. An app can only ever read its own file.
 *
 * Served from voidshell's origin root, so a project at /apps/<id>/ can load it
 * as an absolute path without vendoring a copy.
 *
 * Deliberately dependency-free ES5-ish: this gets loaded by Godot exports,
 * Phaser bundles and hand-written HTML alike, and must not assume a build step.
 */
(function () {
  "use strict";

  /* Standalone, or a shell that has no secrets service, would otherwise leave
   * the caller awaiting a promise that never settles. Resolving empty lets an
   * app degrade to "no key configured" instead of hanging on boot. */
  var TIMEOUT_MS = 3000;

  function request(op, key) {
    return new Promise(function (resolve) {
      var empty = op === "list" ? [] : null;

      if (window.parent === window) return resolve(empty);

      var channel = new MessageChannel();
      var settled = false;

      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          channel.port1.close();
        } catch (e) {
          /* already closed */
        }
        resolve(value);
      }

      var timer = setTimeout(function () {
        finish(empty);
      }, TIMEOUT_MS);

      channel.port1.onmessage = function (event) {
        var data = event.data || {};
        if (!data.ok) {
          if (data.error) console.warn("[voidshell-config] " + data.error);
          return finish(empty);
        }
        finish(data.value === undefined ? empty : data.value);
      };

      window.parent.postMessage(
        { __voidshell: "secrets", op: op, key: key },
        // Never "*": the shell is same-origin, and a wildcard would post the
        // request to whatever happened to be framing this document.
        window.location.origin,
        [channel.port2]
      );
    });
  }

  window.voidshellConfig = {
    /** Resolve one value, or null when it is not set. */
    get: function (key) {
      return request("get", key);
    },
    /** Names only, never values — for "you still need to set X" messaging. */
    list: function () {
      return request("list");
    },
  };
})();
