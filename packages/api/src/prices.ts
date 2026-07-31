import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.js";
import type { Store } from "./store.js";
import type { Signal } from "./stonks.js";

/**
 * The market-data half of the paper-trading simulator.
 *
 * `stonks.ts` takes signals and returns decisions; something has to produce the
 * signals. In the Next.js app that came before this, a server route fetched
 * daily bars and cached them in a `price_snapshots` table. A static module in
 * the shell can't do either — it has no key to spend and no table to write to —
 * so the same job lands here.
 *
 * The interesting part is not the fetching. Every provider hands back a stack
 * of daily bars in its own shape; `toSignal` turns bars into the exact `Signal`
 * the decision route expects, and that transformation is provider-independent,
 * pure, and the only thing in this file worth testing.
 *
 * Simulation only. These are delayed end-of-day bars and nothing here is advice.
 */

/** One daily bar, oldest-to-newest in every array this module passes around. */
export interface Bar {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  close: number;
  volume: number;
}

/** Enough history for a 30-day change plus a 30-day volume baseline. */
const HISTORY_DAYS = 90;

/** Matches the decision route's cap, so a run can price everything it decides. */
const MAX_TICKERS = 40;

/** Bars are end-of-day, so a cached one is good until the next close. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const TICKER_RE = /^[A-Z.\-]{1,10}$/;

/* -------------------------------------------------------------------------- */
/*  Signal computation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Trailing return over `n` trading days.
 *
 * Indexed off the end of the array rather than by date because bars skip
 * weekends and holidays — "30 days ago" and "30 bars ago" are different
 * questions, and the one the signals want is bars.
 */
function changeOver(bars: Bar[], n: number): number | undefined {
  if (bars.length < n + 1) return undefined;
  const now = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - n].close;
  if (!(then > 0)) return undefined;
  return (now - then) / then;
}

/**
 * Today's volume against its own 30-day average — the "is anyone actually
 * trading this" number. Excludes the latest bar from the baseline so a spike
 * doesn't dilute the average it is being measured against.
 */
function volumeRatio(bars: Bar[]): number | undefined {
  if (bars.length < 6) return undefined;
  const latest = bars[bars.length - 1].volume;
  const window = bars.slice(Math.max(0, bars.length - 31), bars.length - 1);
  if (window.length === 0) return undefined;
  const mean = window.reduce((s, b) => s + b.volume, 0) / window.length;
  if (!(mean > 0)) return undefined;
  return latest / mean;
}

/**
 * Bars to a `Signal`, or null if there is not enough history to price it.
 *
 * Optional fields are omitted rather than sent as null: the decision route
 * renders anything missing as "n/a", and a null would be reported as a real
 * reading of zero.
 */
export function toSignal(ticker: string, bars: Bar[]): Signal | null {
  if (bars.length === 0) return null;
  const price = bars[bars.length - 1].close;
  if (!Number.isFinite(price) || price <= 0) return null;

  const c1 = changeOver(bars, 1);
  const c5 = changeOver(bars, 5);
  const c30 = changeOver(bars, 30);
  const vr = volumeRatio(bars);

  return {
    ticker,
    price,
    ...(c1 === undefined ? {} : { change1d: c1 }),
    ...(c5 === undefined ? {} : { change5d: c5 }),
    ...(c30 === undefined ? {} : { change30d: c30 }),
    ...(vr === undefined ? {} : { volumeRatio: vr }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Providers                                                                 */
/* -------------------------------------------------------------------------- */

export interface PriceProvider {
  readonly name: string;
  /** Oldest-to-newest daily bars, or an empty array if the ticker is unknown. */
  fetchBars(ticker: string): Promise<Bar[]>;
}

/**
 * Stooq: daily CSV, no key, no signup. The default because it makes the module
 * work on a fresh server with nothing configured, which is the difference
 * between a feature and a feature with a setup guide.
 */
const stooq: PriceProvider = {
  name: "stooq",
  async fetchBars(ticker) {
    const sym = `${ticker.toLowerCase().replace(/\./g, "-")}.us`;
    const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`);
    if (!res.ok) throw new Error(`stooq ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split("\n");
    // A miss returns a one-line body rather than a 404, so an empty result is
    // "no such ticker" and not a transport failure.
    if (lines.length < 2) return [];
    const bars: Bar[] = [];
    for (const line of lines.slice(1)) {
      const [date, , , , close, volume] = line.split(",");
      const c = Number(close);
      const v = Number(volume);
      if (!date || !Number.isFinite(c) || c <= 0) continue;
      bars.push({ date, close: c, volume: Number.isFinite(v) ? v : 0 });
    }
    return bars.slice(-HISTORY_DAYS);
  },
};

/** Tiingo: keyed, but a far better free tier and cleaner data than the default. */
function tiingo(token: string): PriceProvider {
  return {
    name: "tiingo",
    async fetchBars(ticker) {
      const start = new Date(Date.now() - HISTORY_DAYS * 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const url =
        `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}` +
        `/prices?startDate=${start}&format=json`;
      const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`tiingo ${res.status}`);
      const rows = (await res.json()) as { date: string; close: number; volume: number }[];
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => Number.isFinite(r.close) && r.close > 0)
        .map((r) => ({
          date: String(r.date).slice(0, 10),
          close: r.close,
          volume: Number.isFinite(r.volume) ? r.volume : 0,
        }))
        .slice(-HISTORY_DAYS);
    },
  };
}

/**
 * A deterministic pseudo-market, seeded off the ticker.
 *
 * This is not a placeholder to be replaced later — it is the same idea as the
 * decision route's `fallback: "mock"`. A server with no outbound network, or a
 * provider having a bad afternoon, should still give someone a simulator that
 * runs. Same ticker, same bars, every time, so a portfolio built against it
 * stays coherent across restarts.
 */
export const mockProvider: PriceProvider = {
  name: "mock",
  async fetchBars(ticker) {
    let seed = 0;
    for (let i = 0; i < ticker.length; i++) seed = (seed * 31 + ticker.charCodeAt(i)) >>> 0;
    const rand = () => {
      // xorshift32: cheap, and the point is repeatability rather than quality.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0xffffffff;
    };
    let close = 20 + (seed % 400);
    const bars: Bar[] = [];
    const today = Date.now();
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      close = Math.max(1, close * (1 + (rand() - 0.5) * 0.04));
      bars.push({
        date: new Date(today - i * 86_400_000).toISOString().slice(0, 10),
        close: Math.round(close * 100) / 100,
        volume: Math.round(1e6 * (0.5 + rand())),
      });
    }
    return bars;
  },
};

/** Reads the environment once. Falls back rather than throwing. */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): PriceProvider {
  const choice = (env.STONKS_PRICE_PROVIDER ?? "").toLowerCase();
  if (choice === "mock") return mockProvider;
  if (choice === "tiingo" || (!choice && env.TIINGO_API_KEY)) {
    const token = env.TIINGO_API_KEY;
    if (token) return tiingo(token);
  }
  if (choice === "stooq" || !choice) return stooq;
  return stooq;
}

/* -------------------------------------------------------------------------- */
/*  Route                                                                     */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  at: number;
  bars: Bar[];
}

interface PricesBody {
  tickers?: unknown;
}

export function registerPrices(app: FastifyInstance, store: Store): void {
  const provider = selectProvider();
  app.log.info(`stonks price provider: ${provider.name}`);

  // Prices are global, not per-user, so they live here rather than in the
  // store: caching them per account would multiply identical upstream calls by
  // the number of people signed in.
  const cache = new Map<string, CacheEntry>();

  async function barsFor(ticker: string): Promise<Bar[]> {
    const hit = cache.get(ticker);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bars;
    const bars = await provider.fetchBars(ticker);
    cache.set(ticker, { at: Date.now(), bars });
    return bars;
  }

  app.post<{ Body: PricesBody }>(
    "/api/stonks/prices",
    {
      // Looser than the decision route: this is cheap and cached, but it does
      // reach a third party, and an unbounded loop here would burn someone
      // else's quota rather than ours.
      config: { rateLimit: { max: 120, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      const user = await requireUser(store, req, reply);
      if (!user) return reply;

      const raw = req.body?.tickers;
      if (!Array.isArray(raw) || raw.length === 0) {
        return reply.code(400).send({ error: "tickers must be a non-empty array" });
      }
      if (raw.length > MAX_TICKERS) {
        return reply.code(400).send({ error: `at most ${MAX_TICKERS} tickers per request` });
      }

      const tickers: string[] = [];
      for (const t of raw) {
        if (typeof t !== "string" || !TICKER_RE.test(t)) {
          return reply.code(400).send({ error: "each ticker must be up to 10 uppercase characters" });
        }
        if (!tickers.includes(t)) tickers.push(t);
      }

      const signals: Signal[] = [];
      const unavailable: string[] = [];

      // Settled rather than raced: one dead ticker should cost that ticker, not
      // the whole run. A partial price list is still a usable one.
      const results = await Promise.allSettled(tickers.map((t) => barsFor(t)));
      results.forEach((result, i) => {
        const ticker = tickers[i];
        if (result.status !== "fulfilled") {
          req.log.warn({ ticker, err: result.reason }, "price fetch failed");
          unavailable.push(ticker);
          return;
        }
        const signal = toSignal(ticker, result.value);
        if (signal) signals.push(signal);
        else unavailable.push(ticker);
      });

      if (signals.length === 0) {
        // Same shape the decision route uses, so the module has one way of
        // recognising "the server is up but the data isn't".
        return reply.code(502).send({
          error: "no prices available",
          fallback: "mock",
          unavailable,
        });
      }

      return reply.send({ signals, unavailable, provider: provider.name });
    }
  );
}
