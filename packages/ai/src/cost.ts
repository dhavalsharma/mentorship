/**
 * Per-million-token prices, so `ai_runs.cost_usd` is a number rather than a
 * shrug. Cached here rather than fetched: a price that changes silently under
 * a cost dashboard is worse than one that is visibly stale.
 *
 * Checked against the published table on 2026-06-24. Anthropic first-party
 * rates; Bedrock and Vertex are partner-operated and priced separately.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
};

/**
 * An unknown model costs 0 rather than throwing. A price table that has not
 * caught up with a model release must not be able to break a session — the
 * number is for reporting, and a zero in a dashboard is a visible prompt to
 * update this file.
 */
export function costUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  return (
    (tokensIn / 1_000_000) * price.inputPerMTok +
    (tokensOut / 1_000_000) * price.outputPerMTok
  );
}
