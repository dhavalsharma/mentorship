import { z } from "zod";

/**
 * A Thompson-sampling bandit over the handful of templates we have per deficit
 * type. Forty lines, no training pipeline, no feature store — and it beats a
 * static template inside one cohort, because the thing it is learning ("does
 * this phrasing get a session booked") has a fast, unambiguous label.
 *
 * Why Thompson rather than epsilon-greedy: with this little traffic the
 * interesting question is not "which template is best" but "which have we not
 * tried enough to know". Sampling from the posterior spends exploration where
 * the uncertainty actually is, and it needs no schedule to tune.
 *
 * The sampler is injectable and seedable. A bandit that cannot be replayed is
 * a bandit whose regressions are invisible.
 */

export const TemplateStatSchema = z.object({
  templateId: z.string(),
  /** Nudges followed by a booked session inside the attribution window. */
  wins: z.number().int().min(0).default(0),
  /** Nudges that were not. A drop is not a loss — it was never delivered. */
  losses: z.number().int().min(0).default(0),
});
export type TemplateStat = z.infer<typeof TemplateStatSchema>;

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

/** mulberry32. Small, fast, and good enough for choosing between six strings. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const systemRng: Rng = { next: () => Math.random() };

/**
 * Marsaglia–Tsang. Beta(a, b) = X / (X + Y) with X ~ Gamma(a), Y ~ Gamma(b),
 * which avoids needing an inverse incomplete beta for two integer-ish shapes.
 */
function gammaSample(shape: number, rng: Rng): number {
  if (shape < 1) {
    // Boost, then correct: Gamma(a) = Gamma(a+1) * U^(1/a).
    const u = Math.max(rng.next(), Number.EPSILON);
    return gammaSample(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded rather than `while (true)`: the acceptance rate here is >95%, so
  // a hundred rejections means the rng is broken, and a hung sweep is worse
  // than a very slightly biased draw.
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = normalSample(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, Number.EPSILON)) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
  return d;
}

function normalSample(rng: Rng): number {
  // Box–Muller. One of the two draws is discarded; at this call volume the
  // bookkeeping to keep it costs more than the draw.
  const u1 = Math.max(rng.next(), Number.EPSILON);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function betaSample(alpha: number, beta: number, rng: Rng): number {
  const x = gammaSample(alpha, rng);
  const y = gammaSample(beta, rng);
  const total = x + y;
  return total > 0 ? x / total : 0.5;
}

export interface RankedTemplate {
  templateId: string;
  /** The posterior draw this round. Explanatory only — never shown as a rate. */
  score: number;
  stat: TemplateStat;
}

export interface TemplateBandit {
  rank(candidates: string[], stats: TemplateStat[]): RankedTemplate[];
}

/**
 * Beta(1 + wins, 1 + losses) — a uniform prior, which says "we know nothing"
 * rather than "we assume it works". With zero data every template gets an
 * equal chance, which is exactly what a new deficit type should get.
 */
export class ThompsonBandit implements TemplateBandit {
  constructor(private readonly rng: Rng = systemRng) {}

  rank(candidates: string[], stats: TemplateStat[]): RankedTemplate[] {
    const byId = new Map(stats.map((s) => [s.templateId, s]));
    return candidates
      .map((templateId) => {
        const stat =
          byId.get(templateId) ?? { templateId, wins: 0, losses: 0 };
        return {
          templateId,
          score: betaSample(1 + stat.wins, 1 + stat.losses, this.rng),
          stat,
        };
      })
      .sort((a, b) => b.score - a.score || a.templateId.localeCompare(b.templateId));
  }
}

/**
 * No exploration: highest observed rate wins, ties broken by id. Exists for
 * the operator who wants a frozen policy during a pilot, and to make "did the
 * bandit help?" answerable against something.
 */
export class GreedyBandit implements TemplateBandit {
  rank(candidates: string[], stats: TemplateStat[]): RankedTemplate[] {
    const byId = new Map(stats.map((s) => [s.templateId, s]));
    return candidates
      .map((templateId) => {
        const stat = byId.get(templateId) ?? { templateId, wins: 0, losses: 0 };
        const n = stat.wins + stat.losses;
        return { templateId, score: n === 0 ? 0 : stat.wins / n, stat };
      })
      .sort((a, b) => b.score - a.score || a.templateId.localeCompare(b.templateId));
  }
}
