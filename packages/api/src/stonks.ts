import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.js";
import type { Store } from "./store.js";

/**
 * The decision half of the paper-trading simulator.
 *
 * This route exists so the API key doesn't have to live in a dashboard. The
 * static fork this module came from called api.anthropic.com straight from the
 * browser with `anthropic-dangerous-direct-browser-access`, because a static
 * site has nowhere else to put a key. voidshell has a server now, so the key
 * stays on it — which also means the signup warning ("do not put anything
 * private, sensitive, or valuable in here") stays true.
 *
 * Simulation only. Nothing here places a real order, and the model's output is
 * an experiment rather than advice.
 */

const MODEL = "claude-opus-5";

/** Enough for a few dozen tickers plus reasoning; well under the HTTP timeout. */
const MAX_TOKENS = 16_000;

/** A run is one decision per candidate, so the cap is on tickers per request. */
const MAX_TICKERS = 40;

export interface Signal {
  ticker: string;
  price: number;
  change1d?: number;
  change5d?: number;
  change30d?: number;
  volumeRatio?: number;
}

export interface Holding {
  shares: number;
  value: number;
}

/**
 * Raw JSON Schema rather than zod: the API package has three dependencies and
 * a schema this small doesn't justify a fourth.
 *
 * No `minimum`/`maximum` on confidence — structured outputs don't enforce
 * numeric constraints, so a bound written here would be decorative. It is
 * clamped after parsing instead.
 */
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          action: { type: "string", enum: ["BUY", "SELL", "HOLD"] },
          confidence: { type: "number", description: "0 to 1" },
          shares: { type: ["integer", "null"], description: "null lets the sizer decide" },
          reasoning: { type: "string" },
        },
        required: ["ticker", "action", "confidence", "shares", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You are the decision engine of a paper-trading simulator. No real money is",
  "involved and no order you describe is ever placed — every trade is a ledger",
  "entry in a simulation built for learning.",
  "",
  "Return exactly one decision for every ticker you are given. HOLD is very",
  "often the correct answer; only propose a BUY or a SELL when the signals",
  "actually justify one, and say why in the reasoning.",
  "",
  "Confidence is your own estimate between 0 and 1. A deterministic risk gate",
  "runs after you and will reject or resize anything that breaches its limits,",
  "so propose what you believe rather than what you think will pass.",
].join("\n");

interface DecideBody {
  signals?: unknown;
  portfolio?: unknown;
}

export interface RawDecision {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  shares: number | null;
  reasoning: string;
}

function validate(body: DecideBody): { signals: Signal[]; portfolio: { cash: number; totalValue: number; holdings: Record<string, Holding> } } | { error: string } {
  const { signals, portfolio } = body;
  if (!Array.isArray(signals) || signals.length === 0) {
    return { error: "signals must be a non-empty array" };
  }
  if (signals.length > MAX_TICKERS) {
    return { error: `at most ${MAX_TICKERS} tickers per run` };
  }
  const clean: Signal[] = [];
  for (const s of signals) {
    if (typeof s !== "object" || s === null) return { error: "each signal must be an object" };
    const sig = s as Record<string, unknown>;
    if (typeof sig.ticker !== "string" || !/^[A-Z.\-]{1,10}$/.test(sig.ticker)) {
      return { error: "each signal needs a ticker of up to 10 uppercase characters" };
    }
    if (typeof sig.price !== "number" || !Number.isFinite(sig.price) || sig.price <= 0) {
      return { error: `signal for ${sig.ticker} needs a positive price` };
    }
    clean.push({
      ticker: sig.ticker,
      price: sig.price,
      ...(typeof sig.change1d === "number" ? { change1d: sig.change1d } : {}),
      ...(typeof sig.change5d === "number" ? { change5d: sig.change5d } : {}),
      ...(typeof sig.change30d === "number" ? { change30d: sig.change30d } : {}),
      ...(typeof sig.volumeRatio === "number" ? { volumeRatio: sig.volumeRatio } : {}),
    });
  }

  if (typeof portfolio !== "object" || portfolio === null) return { error: "portfolio must be an object" };
  const p = portfolio as Record<string, unknown>;
  if (typeof p.cash !== "number" || typeof p.totalValue !== "number") {
    return { error: "portfolio needs numeric cash and totalValue" };
  }
  const holdings: Record<string, Holding> = {};
  if (p.holdings && typeof p.holdings === "object" && !Array.isArray(p.holdings)) {
    for (const [k, v] of Object.entries(p.holdings as Record<string, unknown>)) {
      const h = v as Record<string, unknown>;
      if (typeof h?.shares === "number" && typeof h?.value === "number") {
        holdings[k] = { shares: h.shares, value: h.value };
      }
    }
  }
  return { signals: clean, portfolio: { cash: p.cash, totalValue: p.totalValue, holdings } };
}

function pct(n: number | undefined): string {
  return n === undefined ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

export function registerStonks(app: FastifyInstance, store: Store): void {
  const key = process.env.ANTHROPIC_API_KEY;
  const client = key ? new Anthropic({ apiKey: key }) : null;

  if (!client) {
    app.log.warn("ANTHROPIC_API_KEY is not set — /api/stonks/decide will report unavailable");
  }

  app.post<{ Body: DecideBody }>(
    "/api/stonks/decide",
    {
      // A model call is the one expensive thing a signed-in user can trigger,
      // so it gets a budget. Keyed per IP like signin; the session check above
      // already stops anonymous traffic reaching it at all.
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      const user = await requireUser(store, req, reply);
      if (!user) return reply;

      // Validation first, and deliberately before the client check: it costs
      // nothing, doesn't depend on a key, and a malformed body should get the
      // same 400 whether or not this particular server can reach a model.
      const checked = validate(req.body ?? {});
      if ("error" in checked) return reply.code(400).send({ error: checked.error });
      const { signals, portfolio } = checked;

      if (!client) {
        // 503 rather than 500: the module falls back to its deterministic mock
        // provider on this, which is a working simulator rather than an error.
        return reply.code(503).send({
          error: "no model configured on this server",
          fallback: "mock",
        });
      }

      const held = Object.entries(portfolio.holdings)
        .map(([t, h]) => `${t}: ${h.shares} shares, $${h.value.toFixed(2)}`)
        .join("\n") || "(none)";

      const table = signals
        .map(
          (s) =>
            `${s.ticker}  price $${s.price.toFixed(2)}  1d ${pct(s.change1d)}  ` +
            `5d ${pct(s.change5d)}  30d ${pct(s.change30d)}  vol ${s.volumeRatio?.toFixed(2) ?? "n/a"}x`
        )
        .join("\n");

      try {
        const response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM,
          thinking: { type: "adaptive" },
          output_config: { format: { type: "json_schema", schema: DECISION_SCHEMA } },
          // Recommended default on this model: a safety classifier can decline
          // a request, and "default" routes by refusal category rather than
          // pinning a model this code would then have to keep up to date.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: [
            {
              role: "user",
              content: [
                `Cash: $${portfolio.cash.toFixed(2)}`,
                `Total portfolio value: $${portfolio.totalValue.toFixed(2)}`,
                "",
                "Current holdings:",
                held,
                "",
                "Candidates:",
                table,
                "",
                "Return one decision for every ticker listed under Candidates.",
              ].join("\n"),
            },
          ],
        });

        // Checked before reading content: on a refusal the array is empty
        // (pre-output) or partial (mid-stream), and indexing it blindly throws.
        if (response.stop_reason === "refusal") {
          req.log.warn({ stopDetails: response.stop_details }, "model declined the decision request");
          return reply.code(502).send({ error: "the model declined this request", fallback: "mock" });
        }

        const text = response.content.find((b) => b.type === "text");
        if (!text || text.type !== "text") {
          return reply.code(502).send({ error: "no decision returned", fallback: "mock" });
        }

        const parsed = JSON.parse(text.text) as { decisions?: unknown };
        if (!Array.isArray(parsed.decisions)) {
          return reply.code(502).send({ error: "malformed decision payload", fallback: "mock" });
        }

        const asked = new Set(signals.map((s) => s.ticker));
        const decisions: RawDecision[] = [];
        for (const d of parsed.decisions as RawDecision[]) {
          // Only tickers that were actually asked about. The schema constrains
          // shape, not content, and a decision about something the user never
          // holds or watches has nowhere to go.
          if (!asked.has(d.ticker)) continue;
          decisions.push({
            ticker: d.ticker,
            action: d.action,
            confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)),
            shares: typeof d.shares === "number" ? Math.floor(Math.abs(d.shares)) : null,
            reasoning: String(d.reasoning ?? "").slice(0, 2000),
          });
        }

        req.log.info({ userId: user.id, count: decisions.length }, "decisions returned");
        return reply.send({ decisions, model: response.model });
      } catch (err) {
        req.log.error({ err }, "decision request failed");
        // The client falls back to its mock provider rather than showing an
        // error, so a missing key or a bad day upstream degrades to a working
        // simulator instead of a broken app.
        return reply.code(502).send({ error: "could not reach the model", fallback: "mock" });
      }
    }
  );
}
