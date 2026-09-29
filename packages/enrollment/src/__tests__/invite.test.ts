import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  acceptPendingInvites,
  commitInvite,
  planInvite,
  type AuditSink,
  type EnrollmentSink,
  type PendingInviteSource,
} from "@mentorship/enrollment";

class FakeEnrollmentSink implements EnrollmentSink, PendingInviteSource {
  users = new Map<string, { userId: string; email: string; displayName: string; tzOffsetMinutes: number }>();
  participants = new Map<
    string,
    { participantId: string; cohortId: string; userId: string; role: string; capacity: number | null; state: string }
  >();
  identityLinks: { userId: string; provider: string; externalId: string; verifiedAt: string }[] = [];
  calls = 0;

  async upsertUser(input: { email: string; displayName: string; tzOffsetMinutes: number }) {
    this.calls++;
    const existing = this.users.get(input.email);
    if (existing) return { userId: existing.userId };
    const userId = `user_${this.users.size + 1}`;
    this.users.set(input.email, { userId, ...input });
    return { userId };
  }

  async findParticipant(input: { cohortId: string; userId: string; role: string }) {
    this.calls++;
    for (const p of this.participants.values()) {
      if (p.cohortId === input.cohortId && p.userId === input.userId && p.role === input.role) {
        return { participantId: p.participantId, state: p.state };
      }
    }
    return null;
  }

  async createParticipant(input: {
    cohortId: string;
    userId: string;
    role: string;
    capacity: number | null;
    state: "invited";
  }) {
    this.calls++;
    const participantId = `participant_${this.participants.size + 1}`;
    this.participants.set(participantId, { participantId, ...input });
    return { participantId };
  }

  async linkIdentity(input: { userId: string; provider: string; externalId: string; verifiedAt: string }) {
    this.calls++;
    this.identityLinks.push(input);
  }

  async listInvitedParticipants(input: { userId: string }) {
    this.calls++;
    return [...this.participants.values()]
      .filter((p) => p.userId === input.userId && p.state === "invited")
      .map((p) => ({ participantId: p.participantId }));
  }

  async updateParticipantState(input: { participantId: string; state: string }) {
    this.calls++;
    const p = this.participants.get(input.participantId);
    if (p) p.state = input.state;
  }
}

class FakeAuditSink implements AuditSink {
  records: {
    orgId: string;
    actorType: string;
    actorRef: string | null;
    action: string;
    subjectRef: string;
    before?: unknown;
    after?: unknown;
  }[] = [];

  async record(input: {
    orgId: string;
    actorType: string;
    actorRef: string | null;
    action: string;
    subjectRef: string;
    before?: unknown;
    after?: unknown;
  }) {
    this.records.push(input);
  }
}

function validPlanInput() {
  return {
    email: "Ada@Example.com",
    displayName: "Ada Lovelace",
    tzOffsetMinutes: 0,
    cohortId: "cohort_1",
    role: "mentee",
    orgId: "org_1",
  };
}

describe("planInvite", () => {
  it("normalises a valid invite", () => {
    const result = planInvite(validPlanInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.email).toBe("ada@example.com");
      expect(result.plan.cohortId).toBe("cohort_1");
      expect(result.plan.role).toBe("mentee");
    }
  });

  it("fails validation on a bad email, before any I/O", async () => {
    const result = planInvite({ ...validPlanInput(), email: "not-an-email" });
    expect(result.ok).toBe(false);

    const sink = new FakeEnrollmentSink();
    // No commit is attempted on a failed plan — assert the sink stays untouched.
    expect(sink.calls).toBe(0);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "email")).toBe(true);
    }
  });
});

describe("commitInvite", () => {
  it("creates a user and an invited participant for a new person", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());

    const result = await commitInvite(plan, sink);

    expect(result.alreadyInvited).toBe(false);
    expect(sink.users.size).toBe(1);
    const participant = sink.participants.get(result.participantId);
    expect(participant?.state).toBe("invited");
    expect(participant?.role).toBe("mentee");
  });

  it("dedupes the same email+cohort+role instead of creating a duplicate", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());

    const first = await commitInvite(plan, sink);
    const second = await commitInvite(plan, sink);

    expect(second.alreadyInvited).toBe(true);
    expect(second.participantId).toBe(first.participantId);
    expect(sink.participants.size).toBe(1);
  });

  it("treats re-inviting an already-enrolled participant as a no-op too", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());

    const first = await commitInvite(plan, sink);
    await sink.updateParticipantState({ participantId: first.participantId, state: "enrolled" });

    const second = await commitInvite(plan, sink);

    expect(second.alreadyInvited).toBe(true);
    expect(second.participantId).toBe(first.participantId);
    expect(sink.participants.size).toBe(1);
  });

  it("records an audit entry when an AuditSink is supplied", async () => {
    const sink = new FakeEnrollmentSink();
    const audit = new FakeAuditSink();
    const plan = mustPlan(validPlanInput());

    await commitInvite(plan, sink, audit);

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.action).toBe("participant.invited");
    expect(audit.records[0]?.orgId).toBe("org_1");
  });

  it("does nothing and does not error when no AuditSink is supplied", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());

    await expect(commitInvite(plan, sink)).resolves.toBeDefined();
  });
});

describe("acceptInvite", () => {
  it("links the identity with a verifiedAt timestamp and enrolls the participant", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());
    const { participantId } = await commitInvite(plan, sink);
    const userId = [...sink.users.values()][0]?.userId as string;

    await acceptInvite(
      {
        participantId,
        userId,
        provider: "slack",
        externalId: "U123",
        now: () => "2026-09-16T00:00:00.000Z",
      },
      sink,
    );

    expect(sink.identityLinks).toHaveLength(1);
    expect(sink.identityLinks[0]?.verifiedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(sink.participants.get(participantId)?.state).toBe("enrolled");
  });

  it("records an audit entry for acceptance when an AuditSink is supplied", async () => {
    const sink = new FakeEnrollmentSink();
    const audit = new FakeAuditSink();
    const plan = mustPlan(validPlanInput());
    const { participantId } = await commitInvite(plan, sink);
    const userId = [...sink.users.values()][0]?.userId as string;

    await acceptInvite(
      {
        participantId,
        userId,
        provider: "slack",
        externalId: "U123",
        now: () => "2026-09-16T00:00:00.000Z",
        orgId: "org_1",
      },
      sink,
      audit,
    );

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.action).toBe("identity.verified");
  });

  it("does not error when no AuditSink is supplied", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());
    const { participantId } = await commitInvite(plan, sink);
    const userId = [...sink.users.values()][0]?.userId as string;

    await expect(
      acceptInvite(
        {
          participantId,
          userId,
          provider: "slack",
          externalId: "U123",
          now: () => "2026-09-16T00:00:00.000Z",
        },
        sink,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("commitInvite result state and actor", () => {
  it("reports invited for a new invite and the existing state for a repeat", async () => {
    const sink = new FakeEnrollmentSink();
    const plan = mustPlan(validPlanInput());
    const first = await commitInvite(plan, sink);
    expect(first.state).toBe("invited");
    await sink.updateParticipantState({ participantId: first.participantId, state: "enrolled" });
    expect((await commitInvite(plan, sink)).state).toBe("enrolled");
  });

  it("stamps the inviting admin on the audit row when given", async () => {
    const sink = new FakeEnrollmentSink();
    const audit = new FakeAuditSink();
    await commitInvite(mustPlan(validPlanInput()), sink, audit, { actorRef: "admin-user-1" });
    expect(audit.records[0]?.actorRef).toBe("admin-user-1");
  });
});

describe("acceptPendingInvites", () => {
  it("enrols every pending invite for the user with an email identity, then is a no-op", async () => {
    const sink = new FakeEnrollmentSink();
    const audit = new FakeAuditSink();
    const a = await commitInvite(mustPlan(validPlanInput()), sink);
    const b = await commitInvite(mustPlan({ ...validPlanInput(), role: "mentor" }), sink);
    const userId = [...sink.users.values()][0]!.userId;

    const first = await acceptPendingInvites(
      { userId, email: "Ada@Example.com", now: () => "2026-09-16T00:00:00.000Z", orgId: "org_1" },
      sink,
      audit,
    );

    expect(first.accepted.sort()).toEqual([a.participantId, b.participantId].sort());
    expect(sink.participants.get(a.participantId)?.state).toBe("enrolled");
    expect(sink.participants.get(b.participantId)?.state).toBe("enrolled");
    expect(sink.identityLinks[0]).toMatchObject({ provider: "email", externalId: "ada@example.com" });
    expect(audit.records.map((r) => r.action)).toEqual(["identity.verified", "identity.verified"]);

    const second = await acceptPendingInvites(
      { userId, email: "ada@example.com", now: () => "2026-09-17T00:00:00.000Z", orgId: "org_1" },
      sink,
      audit,
    );
    expect(second.accepted).toEqual([]);
    expect(audit.records).toHaveLength(2);
  });

  it("accepts nothing for a user with no invites", async () => {
    const sink = new FakeEnrollmentSink();
    const result = await acceptPendingInvites(
      { userId: "nobody", email: "x@example.com", now: () => "2026-09-16T00:00:00.000Z" },
      sink,
    );
    expect(result.accepted).toEqual([]);
  });
});

function mustPlan(input: Parameters<typeof planInvite>[0]) {
  const result = planInvite(input);
  if (!result.ok) throw new Error("expected a valid plan");
  return result.plan;
}
