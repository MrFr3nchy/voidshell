/**
 * Ignition. One point of light expands into the world, then dissolves to
 * reveal the void. This is the signature moment — the OS coming into being —
 * so the rest of the shell stays quiet. Honors prefers-reduced-motion.
 */
export function runBootSequence(): Promise<void> {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const veil = document.createElement("div");
  veil.className = "boot-veil";
  const spark = document.createElement("div");
  spark.className = "boot-spark";
  const word = document.createElement("div");
  word.className = "boot-word";
  word.textContent = "voidshell";
  veil.append(spark, word);
  document.body.appendChild(veil);

  return new Promise((resolve) => {
    if (reduce) {
      veil.remove();
      resolve();
      return;
    }
    requestAnimationFrame(() => veil.classList.add("ignite"));
    window.setTimeout(() => {
      veil.classList.add("clear");
      window.setTimeout(() => {
        veil.remove();
        resolve();
      }, 900);
    }, 1700);
  });
}
