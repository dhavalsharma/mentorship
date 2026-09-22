import { z } from "zod";
import type { OrgId, PairingId, ParticipantId } from "./ids.js";

/**
 * The visibility matrix (ROADMAP phase 4, invariant 14).
 *
 * Everything else in this file is plumbing around one rule that is not
 * negotiable: **individual feedback sentiment is visible only to the pair it
 * belongs to** — never to an admin, a program lead, or anyone else, at any
 * level of the org chart, for any reason. Activity — did they meet, how many
 * sessions, cadence adherence — stays visible to admins exactly as it is
 * today. This module is what turns that sentence into something a route can
 * call instead of trusting every future caller to remember it.
 *
 * Deliberately pure and synchronous: no db, no request object, nothing
 * async. `authorize` is a function of two plain descriptions of "who" and
 * "what", so it is trivial to unit test exhaustively and trivial to call from
 * any surface (an HTTP route today, a saga resolver or a GraphQL field
 * tomorrow) without dragging that surface's concerns into core (invariant 1).
 *
 * This is authorization, not authentication — it never establishes *who* the
 * caller is (that is `packages/auth`'s job) or *which pairings* they belong
 * to (that is a query the caller must run first, honestly, against
 * `participants`). Feed it a spoofed `pairingIds` and it will happily hand
 * back `allowed: true` — same as any authorization check handed a lie about
 * its input.
 */

/**
 * `admin` and `program_lead` are org-chart roles: they can see aggregate
 * activity across every pairing in their org, and they can NEVER see
 * individually-attributed feedback, no matter how senior. `mentor` and
 * `mentee` are pair roles: they see their own pairing's data, including its
 * feedback, because they are a party to it — not because of what they are
 * called. `participant` is the generic fallback for a program that has not
 * named its roles (`ProgramPolicySchema.roles` is a free-form string array,
 * so an arbitrary program role that is not one of these four still behaves
 * like a pair member as long as it is not admin-like).
 */
export const ActorRoleSchema = z.enum([
  "admin",
  "program_lead",
  "mentor",
  "mentee",
  "participant",
]);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

/** Org-chart roles. Everyone else is treated as a pair-role actor. */
const ORG_CHART_ROLES: ReadonlySet<ActorRole> = new Set(["admin", "program_lead"]);

export interface Actor {
  orgId: OrgId;
  role: ActorRole;
  /** Absent for a pure org-chart actor with no participant record of their own. */
  participantId?: ParticipantId;
  /**
   * Every pairing this actor is currently a party to (mentor or mentee of).
   * The caller resolves this — from `participants` joined to whatever holds
   * pairing membership — and is trusted to resolve it honestly. This module
   * checks membership; it does not discover it.
   */
  pairingIds: readonly PairingId[];
}

/**
 * What is being read. `pairingId` absent means "an org-wide list" (the admin
 * dashboard's risk-findings/nudges tables today) — never enough on its own
 * to unlock `feedback.sentiment` or a participant-attributed `signal`, since
 * there is no pairing to be a member *of*.
 */
export const ResourceTypeSchema = z.enum([
  /** Did they meet, cadence adherence, counts — attributable, admin-visible. */
  "pairing.activity",
  /** A named person's rating of a session. Never admin-visible. Invariant 14. */
  "feedback.sentiment",
  "risk-finding",
  "nudge",
  /**
   * A raw `signals` row. Whether it behaves like activity or like sentiment
   * depends on `attribution` below — the table itself does not separate them,
   * so a caller reading it must say which one this row is.
   */
  "signal",
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export interface Resource {
  type: ResourceType;
  orgId: OrgId;
  pairingId?: PairingId;
  /**
   * Only meaningful for `type: "signal"`. `"pairing"` is an aggregate over
   * the whole pair (cadence adherence, a composite health score) and is
   * treated as activity. `"participant"` names one person (an individual
   * sentiment rating) and is treated exactly like `feedback.sentiment`.
   * Omitted defaults to `"pairing"` — the safer default would arguably be the
   * other way, but a `signal` resource with no attribution stated is, in this
   * schema, always an aggregate: individually-attributed signals must say so
   * explicitly rather than relying on a default to protect them.
   */
  attribution?: "pairing" | "participant";
}

export interface AuthorizationDecision {
  allowed: boolean;
  /** Always present, allow or deny — the reason a request was let through is
   * as useful to log as the reason it was refused. */
  reason: string;
}

function allow(reason: string): AuthorizationDecision {
  return { allowed: true, reason };
}
function deny(reason: string): AuthorizationDecision {
  return { allowed: false, reason };
}

/**
 * The one function this module exists to provide. Given who is asking and
 * what they are asking for, decide allow/deny. No side effects, no I/O — see
 * the module doc for why that is the point.
 */
export function authorize(actor: Actor, resource: Resource): AuthorizationDecision {
  if (actor.orgId !== resource.orgId) {
    // Invariant 3, restated at the authorization layer: a session's own org
    // is the only org it can ever act within, whatever the resource claims
    // to belong to.
    return deny("cross-org access is always denied");
  }

  const isPairMember =
    resource.pairingId !== undefined && actor.pairingIds.includes(resource.pairingId);
  const isOrgChart = ORG_CHART_ROLES.has(actor.role);

  switch (resource.type) {
    case "feedback.sentiment": {
      // Invariant 14: this branch has no admin/program_lead exception. That
      // omission is the entire point of the function — every other resource
      // type below checks `isOrgChart`; this one deliberately never does.
      if (isPairMember) {
        return allow("actor is a party to this pairing");
      }
      return deny(
        "individual feedback sentiment is visible only to the pair it belongs to",
      );
    }

    case "signal": {
      if (resource.attribution === "participant") {
        // A signal naming one person is sentiment wearing a different table
        // name. Same rule, same reason, on purpose.
        if (isPairMember) {
          return allow("actor is a party to this pairing");
        }
        return deny(
          "a participant-attributed signal is visible only to the pair it belongs to",
        );
      }
      // Aggregate signal (or attribution omitted, which means aggregate —
      // see the field doc): activity data, same rule as pairing.activity.
      if (isOrgChart || isPairMember) {
        return allow("aggregate pairing signal is activity data");
      }
      return deny("actor is neither org-chart staff nor a party to this pairing");
    }

    case "pairing.activity":
    case "risk-finding":
    case "nudge": {
      // Activity is attributable (CLAUDE.md invariant 14's second sentence):
      // an admin or program lead may see it org-wide, and a pair member may
      // always see their own pairing's.
      if (isOrgChart || isPairMember) {
        return allow("activity/attendance data is visible to org-chart staff and pair members");
      }
      return deny("actor is neither org-chart staff nor a party to this pairing");
    }

    default: {
      const exhaustive: never = resource.type;
      return deny(`unknown resource type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Filters a list down to what the actor may see, dropping the rest rather
 * than throwing — the shape a route handler wants when it has already
 * fetched a page of rows and needs to redact before responding.
 */
export function filterAuthorized<T>(
  actor: Actor,
  items: readonly T[],
  toResource: (item: T) => Resource,
): T[] {
  return items.filter((item) => authorize(actor, toResource(item)).allowed);
}
