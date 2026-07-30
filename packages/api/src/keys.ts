import { randomInt } from "node:crypto";
import { WORDS } from "./wordlist.js";

/**
 * Passphrase keys.
 *
 * A key is a bearer token that happens to be pronounceable. There is no
 * password, no email and no recovery: whoever holds the key is the account.
 * That makes two things load-bearing.
 *
 * The first is the source of randomness. `randomInt` is a CSPRNG. Math.random
 * is a fast PRNG seeded from process state, and a key generated from it is
 * predictable to anyone who can observe or guess that state — which for a
 * credential with no second factor is the whole game. There is no acceptable
 * use of Math.random anywhere near this file.
 *
 * The second is length. Four words from a 2048-word list is 44 bits. Three
 * would be 33, and 33 bits is a weekend of scripted guessing against an
 * endpoint that answers quickly. The fourth word costs nothing to say aloud
 * and multiplies the search space by 2048.
 */

export const KEY_WORDS = 4;

/** 2048 words at 11 bits each. Asserted below rather than assumed. */
export const KEY_BITS = KEY_WORDS * Math.log2(WORDS.length);

if (WORDS.length !== 2048) {
  throw new Error(`[keys] wordlist must be 2048 words, got ${WORDS.length}`);
}

/**
 * Mints a key like `shiny-gold-tooth-harbor`.
 *
 * Words may repeat. Rejecting repeats would remove entropy rather than add it,
 * and would leak the constraint to anyone enumerating.
 */
export function generateKey(): string {
  const out: string[] = [];
  for (let i = 0; i < KEY_WORDS; i++) out.push(WORDS[randomInt(WORDS.length)]!);
  return out.join("-");
}

/**
 * Tidies a submitted key without judging it.
 *
 * People paste keys with stray whitespace, capitalisation from a phone
 * keyboard, or an en dash their notes app helpfully substituted. None of that
 * should read as a wrong key. Validity is decided by whether the hash matches
 * a user, not by this function.
 */
export function normalizeKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[‐-―−_\s]+/g, "-") // dashes, underscores, spaces
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Shape check only. Says nothing about whether the key exists. */
export function looksLikeKey(input: string): boolean {
  const parts = normalizeKey(input).split("-");
  return parts.length === KEY_WORDS && parts.every((p) => /^[a-z]{3,8}$/.test(p));
}
