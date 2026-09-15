import { z } from "zod";
import type { ProgramPolicy } from "./policy.js";

/**
 * The four-part shape every AI capability takes. Getting all of them to share
 * one interface is what buys one eval harness, one cost dashboard, one retry
 * policy and one approval queue, instead of four of each.
 *
 * The parts are deliberately separated by how much you can trust them:
 * `resolve` is pure data assembly, `infer` is the only step that can be
 * wrong in an interesting way, `gate` decides how much autonomy the output
 * gets, and `fallback` is what happens when the model is unavailable — a
 * platform whose reminders stop when an API is down is not a platform.
 */

/** Where a claim came from in the unedited source, so it can be checked. */
export const EvidenceSpanSchema = z.object({
  /** Character offsets into the source that was handed to the model. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /** The quoted text, so a UI can render it without re-reading the source. */
  quote: z.string(),
});

export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

/**
 * How much autonomy this output gets, decided per program and per action
 * class. `escalate` is the one that bypasses every queue.
 */
export const GateDecisionSchema = z.enum(["auto", "approve", "log", "escalate"]);
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface LlmStructuredRequest<T> {
  /** Stable instructions. Kept separate from `prompt` so it can be cached. */
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Names the schema for the provider; also the tool name where one is used. */
  schemaName: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * A port, like the adapter ports in `capabilities.ts`: the interface lives in
 * core, the implementations live in `packages/ai`. A hardcoded vendor is the
 * first thing a serious adopter has to rip out.
 */
export interface LlmProvider {
  readonly model: string;
  structured<T>(
    request: LlmStructuredRequest<T>,
  ): Promise<{ value: T; usage: LlmUsage }>;
  /** Only two places earn an embedding: profile narratives and topic mapping. */
  embed?(texts: string[]): Promise<{ vectors: number[][]; usage: LlmUsage }>;
}

export interface Primitive<Trigger, Ctx, Out, Reader = unknown> {
  name: string;
  /** Stamped on every `ai_runs` row, so "did v4 help?" has an answer. */
  promptVersion: string;
  outputSchema: z.ZodType<Out>;

  /**
   * Deterministic context assembly. No model. This is the cheap, testable
   * part, and the thing to fix first when quality is bad.
   */
  resolve(trigger: Trigger, reader: Reader): Promise<Ctx>;

  /**
   * The model call. Structured output only, schema-validated by the runner,
   * which repairs once and then falls back. Never throws into a request path.
   */
  infer(ctx: Ctx, llm: LlmProvider): Promise<Out>;

  /** Policy decides autonomy per action class, per program. */
  gate(out: Out, policy: ProgramPolicy): GateDecision;

  /** A deterministic answer for when the model is unavailable or refuses. */
  fallback(ctx: Ctx): Out;
}
