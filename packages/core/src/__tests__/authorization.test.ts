import { describe, expect, it } from "vitest";
import {
  authorize,
  filterAuthorized,
  type Actor,
  type Resource,
} from "@mentorship/core";
import {
  asOrgId,
  asPairingId,
  asParticipantId,
  type OrgId,
  type PairingId,
} from "@mentorship/core";

/**
 * The invariant-14 test CLAUDE.md flags as missing: "Individual feedback
 * scores are never attributed to a named person outside the pair, at any
 * level of the org chart, for any reason. Activity is attributable;
 * sentiment is not." This suite is the reporting layer's proof of that
 * sentence, plus the rest of the visibility matrix around it.
 */

const ORG_A: OrgId = asOrgId("11111111-1111-1111-1111-111111111111");
const ORG_B: OrgId = asOrgId("22222222-2222-2222-2222-222222222222");
const PAIRING_1: PairingId = asPairingId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const PAIRING_2: PairingId = asPairingId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

function admin(orgId: OrgId = ORG_A): Actor {
  return { orgId, role: "admin", pairingIds: [] };
}
function programLead(orgId: OrgId = ORG_A): Actor {
  return { orgId, role: "program_lead", pairingIds: [] };
}
function pairMember(
  role: "mentor" | "mentee",
  pairingIds: PairingId[],
  orgId: OrgId = ORG_A,
): Actor {
  return {
    orgId,
    role,
    participantId: asParticipantId("cccccccc-cccc-cccc-cccc-cccccccccccc"),
    pairingIds,
  };
}
function outsider(orgId: OrgId = ORG_A): Actor {
  return {
    orgId,
    role: "participant",
    participantId: asParticipantId("dddddddd-dddd-dddd-dddd-dddddddddddd"),
    pairingIds: [],
  };
}

function sentimentOf(pairingId: PairingId, orgId: OrgId = ORG_A): Resource {
  return { type: "feedback.sentiment", orgId, pairingId };
}
function activityOf(pairingId: PairingId | undefined, orgId: OrgId = ORG_A): Resource {
  return { type: "pairing.activity", orgId, ...(pairingId ? { pairingId } : {}) };
}
function riskFindingOf(pairingId: PairingId | undefined, orgId: OrgId = ORG_A): Resource {
  return { type: "risk-finding", orgId, ...(pairingId ? { pairingId } : {}) };
}
function nudgeOf(pairingId: PairingId | undefined, orgId: OrgId = ORG_A): Resource {
  return { type: "nudge", orgId, ...(pairingId ? { pairingId } : {}) };
}
function participantSignalOf(pairingId: PairingId, orgId: OrgId = ORG_A): Resource {
  return { type: "signal", orgId, pairingId, attribution: "participant" };
}
function pairingSignalOf(pairingId: PairingId, orgId: OrgId = ORG_A): Resource {
  return { type: "signal", orgId, pairingId, attribution: "pairing" };
}

describe("invariant 14: individual feedback sentiment", () => {
  it("denies an admin, however the org-wide read is framed", () => {
    expect(authorize(admin(), sentimentOf(PAIRING_1)).allowed).toBe(false);
  });

  it("denies an admin even for the pairing they created/manage", () => {
    // No amount of org-chart seniority is a pairing membership.
    const decision = authorize(admin(), sentimentOf(PAIRING_1));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/visible only to the pair/);
  });

  it("denies a program lead, the next rung up the org chart", () => {
    expect(authorize(programLead(), sentimentOf(PAIRING_1)).allowed).toBe(false);
  });

  it("denies feedback with no pairing named at all (no 'see everything' escape hatch)", () => {
    const orgWide: Resource = { type: "feedback.sentiment", orgId: ORG_A };
    expect(authorize(admin(), orgWide).allowed).toBe(false);
    expect(authorize(programLead(), orgWide).allowed).toBe(false);
  });

  it("denies a participant who is not a party to this specific pairing", () => {
    expect(authorize(outsider(), sentimentOf(PAIRING_1)).allowed).toBe(false);
  });

  it("denies a mentor from a DIFFERENT pairing (activity is not a passport to sentiment)", () => {
    const otherPairMentor = pairMember("mentor", [PAIRING_2]);
    expect(authorize(otherPairMentor, sentimentOf(PAIRING_1)).allowed).toBe(false);
  });

  it("allows a mentor who is a party to this pairing", () => {
    const mentor = pairMember("mentor", [PAIRING_1]);
    const decision = authorize(mentor, sentimentOf(PAIRING_1));
    expect(decision.allowed).toBe(true);
  });

  it("allows a mentee who is a party to this pairing", () => {
    const mentee = pairMember("mentee", [PAIRING_1]);
    expect(authorize(mentee, sentimentOf(PAIRING_1)).allowed).toBe(true);
  });

  it("allows a pair member across several concurrent pairings, scoped to the right one", () => {
    const busyMentor = pairMember("mentor", [PAIRING_1, PAIRING_2]);
    expect(authorize(busyMentor, sentimentOf(PAIRING_1)).allowed).toBe(true);
    expect(authorize(busyMentor, sentimentOf(PAIRING_2)).allowed).toBe(true);
  });

  it("a participant-attributed signal is gated exactly like feedback.sentiment", () => {
    expect(authorize(admin(), participantSignalOf(PAIRING_1)).allowed).toBe(false);
    expect(authorize(programLead(), participantSignalOf(PAIRING_1)).allowed).toBe(false);
    expect(
      authorize(pairMember("mentor", [PAIRING_1]), participantSignalOf(PAIRING_1)).allowed,
    ).toBe(true);
    expect(
      authorize(pairMember("mentor", [PAIRING_2]), participantSignalOf(PAIRING_1)).allowed,
    ).toBe(false);
  });
});

describe("activity is attributable — admins keep seeing it", () => {
  it("allows an admin to read org-wide risk findings", () => {
    expect(authorize(admin(), riskFindingOf(undefined)).allowed).toBe(true);
  });

  it("allows an admin to read org-wide nudges", () => {
    expect(authorize(admin(), nudgeOf(undefined)).allowed).toBe(true);
  });

  it("allows an admin to read a specific pairing's activity", () => {
    expect(authorize(admin(), activityOf(PAIRING_1)).allowed).toBe(true);
  });

  it("allows a program lead the same activity visibility as an admin", () => {
    expect(authorize(programLead(), riskFindingOf(undefined)).allowed).toBe(true);
    expect(authorize(programLead(), nudgeOf(undefined)).allowed).toBe(true);
  });

  it("allows a pairing-aggregate signal (e.g. cadence adherence) to an admin", () => {
    expect(authorize(admin(), pairingSignalOf(PAIRING_1)).allowed).toBe(true);
  });

  it("allows a pair member to read their own pairing's activity", () => {
    const mentee = pairMember("mentee", [PAIRING_1]);
    expect(authorize(mentee, activityOf(PAIRING_1)).allowed).toBe(true);
    expect(authorize(mentee, riskFindingOf(PAIRING_1)).allowed).toBe(true);
    expect(authorize(mentee, nudgeOf(PAIRING_1)).allowed).toBe(true);
  });

  it("denies a pair member org-wide activity across every pairing", () => {
    const mentee = pairMember("mentee", [PAIRING_1]);
    expect(authorize(mentee, riskFindingOf(undefined)).allowed).toBe(false);
    expect(authorize(mentee, nudgeOf(undefined)).allowed).toBe(false);
  });

  it("denies an outsider (no org-chart role, no pairing membership) any activity read", () => {
    expect(authorize(outsider(), riskFindingOf(undefined)).allowed).toBe(false);
    expect(authorize(outsider(), activityOf(PAIRING_1)).allowed).toBe(false);
  });
});

describe("cross-org access is always denied", () => {
  it("denies an admin of org A reading org B's activity", () => {
    expect(authorize(admin(ORG_A), riskFindingOf(undefined, ORG_B)).allowed).toBe(false);
  });

  it("denies an admin of org A reading org B's feedback sentiment (redundantly denied anyway)", () => {
    expect(authorize(admin(ORG_A), sentimentOf(PAIRING_1, ORG_B)).allowed).toBe(false);
  });

  it("denies a pair member of org A whose pairingId happens to collide with one in org B", () => {
    // pairingIds are UUIDs scoped within an org; even if the same PairingId
    // value existed in both (it should not, but tenancy must not rely on
    // that), the org check comes first and denies regardless.
    const mentor = pairMember("mentor", [PAIRING_1], ORG_A);
    expect(authorize(mentor, sentimentOf(PAIRING_1, ORG_B)).allowed).toBe(false);
  });

  it("states the cross-org reason distinctly from the pairing-membership reason", () => {
    const decision = authorize(admin(ORG_A), riskFindingOf(undefined, ORG_B));
    expect(decision.reason).toMatch(/cross-org/);
  });
});

describe("filterAuthorized", () => {
  it("keeps only the rows the actor may see, dropping the rest silently", () => {
    const rows: { pairingId: PairingId; label: string }[] = [
      { pairingId: PAIRING_1, label: "mine" },
      { pairingId: PAIRING_2, label: "not mine" },
    ];
    const mentee = pairMember("mentee", [PAIRING_1]);
    const visible = filterAuthorized(mentee, rows, (row) =>
      sentimentOf(row.pairingId),
    );
    expect(visible.map((r) => r.label)).toEqual(["mine"]);
  });

  it("keeps every row for an admin reading activity, none for sentiment", () => {
    const rows: { pairingId: PairingId }[] = [
      { pairingId: PAIRING_1 },
      { pairingId: PAIRING_2 },
    ];
    const asAdmin = admin();
    expect(
      filterAuthorized(asAdmin, rows, (r) => activityOf(r.pairingId)).length,
    ).toBe(2);
    expect(
      filterAuthorized(asAdmin, rows, (r) => sentimentOf(r.pairingId)).length,
    ).toBe(0);
  });
});

describe("decisions always carry a reason", () => {
  it("on allow", () => {
    expect(authorize(admin(), riskFindingOf(undefined)).reason.length).toBeGreaterThan(0);
  });
  it("on deny", () => {
    expect(authorize(admin(), sentimentOf(PAIRING_1)).reason.length).toBeGreaterThan(0);
  });
});
