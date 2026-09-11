import { randomUUID } from "node:crypto";

/**
 * Branded ids. These cost nothing at runtime and stop the single most common
 * bug in a system with this many foreign keys: passing a participantId where a
 * userId was wanted.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrgId = Brand<string, "OrgId">;
export type ProgramId = Brand<string, "ProgramId">;
export type CohortId = Brand<string, "CohortId">;
export type UserId = Brand<string, "UserId">;
export type ParticipantId = Brand<string, "ParticipantId">;
export type PairingId = Brand<string, "PairingId">;
export type SessionId = Brand<string, "SessionId">;
export type AgreementId = Brand<string, "AgreementId">;
export type SagaInstanceId = Brand<string, "SagaInstanceId">;
export type ExtractionId = Brand<string, "ExtractionId">;

export const asOrgId = (s: string) => s as OrgId;
export const asProgramId = (s: string) => s as ProgramId;
export const asCohortId = (s: string) => s as CohortId;
export const asUserId = (s: string) => s as UserId;
export const asParticipantId = (s: string) => s as ParticipantId;
export const asPairingId = (s: string) => s as PairingId;
export const asSessionId = (s: string) => s as SessionId;
export const asAgreementId = (s: string) => s as AgreementId;
export const asSagaInstanceId = (s: string) => s as SagaInstanceId;
export const asExtractionId = (s: string) => s as ExtractionId;

/** Deterministic-friendly id factory: swap it in tests to get stable output. */
export interface IdFactory {
  next(prefix: string): string;
}

export const uuidIds: IdFactory = {
  next: (prefix) => `${prefix}_${randomUUID()}`,
};

export function sequentialIds(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(3, "0")}`;
    },
  };
}
