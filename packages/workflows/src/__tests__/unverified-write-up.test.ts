import { describe, expect, it, vi } from "vitest";
import { UNVERIFIED_BANNER } from "@mentorship/core";
import { FakeDocument, readManagedRegion } from "@mentorship/integrations";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import { advanceToNextTimer, bootstrap } from "@mentorship/testkit";

/**
 * Invariant 19 at the saga level: when the confirmation window closes, the
 * auto-confirmed write-up is *marked* unverified in the shared doc — the
 * write-up itself stays (journey-suite bug #3).
 */

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun@x.com,Arjun,priya@x.com,Priya,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

async function toConfirming() {
  const h = bootstrap({ transcriptAvailableAfter: 1 });
  const plan = planRosterImport(ONE_PAIR, { policy: h.policy, defaultTzOffsetMinutes: 330 });
  const committed = await commitRosterImport(plan, h.world, { importedPairsStart: "active" });
  await h.dispatcher.settle();
  const pairingId = committed.created[0]!.pairingId;
  const agreement = h.world.latestAgreementFor(pairingId)!;
  for (const p of agreement.participantIds) {
    await h.world.respond(agreement.id, p, "accept", agreement.options[0]!.optionId);
  }
  await h.dispatcher.settle();
  await advanceToNextTimer(h); // reminder
  await advanceToNextTimer(h); // session ends, transcript found, doc rendered
  const [instance] = await h.engine.instances();
  expect(instance!.state).toMatchObject({ name: "confirming" });
  const doc = h.registry.get<FakeDocument>("document")!;
  const docRef = String(h.recorder.of("document.rendered")[0]!.detail["docRef"]);
  return { h, doc, docRef, pairingId };
}

describe("confirming timeout", () => {
  it("renders the banner above the write-up it qualifies, keeping the write-up", async () => {
    const { h, doc, docRef } = await toConfirming();
    const before = readManagedRegion(doc.read(docRef)!)!;
    expect(before).not.toContain(UNVERIFIED_BANNER);

    await advanceToNextTimer(h); // confirmation window closes

    expect(readManagedRegion(doc.read(docRef)!)).toBe(`${UNVERIFIED_BANNER}\n\n${before}`);
  });

  it("does not overwrite a participant's own edit to the write-up", async () => {
    const { h, doc, docRef } = await toConfirming();
    const edited = `${readManagedRegion(doc.read(docRef)!)!}\n\nPriya: fixed the due date.`;
    doc.humanEdit(docRef, edited);

    await advanceToNextTimer(h);

    expect(readManagedRegion(doc.read(docRef)!)).toBe(edited);
    const last = h.recorder.of("document.rendered").at(-1)!;
    expect(last.detail["pinned"]).toBe(true);
  });

  it("honours a participant's Confirm that arrives while the auto-confirm is still failing to render", async () => {
    const { h, doc, docRef, pairingId } = await toConfirming();
    const before = readManagedRegion(doc.read(docRef)!)!;
    const render = vi
      .spyOn(doc, "renderManagedRegion")
      .mockRejectedValue(new Error("Docs outage"));

    await advanceToNextTimer(h); // window closes; the auto-confirm step fails
    const [pending] = await h.engine.instances();
    expect(pending!.pendingStep?.input).toBe("timeout");

    render.mockRestore(); // the click is not what makes the render work
    const [instance] = await h.engine.instances();
    const pair = h.world.pairings.get(pairingId)!;
    for (const p of [pair.mentorParticipantId, pair.menteeParticipantId]) {
      await h.world.confirmExtraction(pairingId, p);
    }
    await h.dispatcher.settle();

    const [after] = await h.engine.instances();
    expect(after!.state).toMatchObject({ name: "feedback" });
    expect(after!.stepIndex).toBeGreaterThan(instance!.stepIndex);
    // A human verdict, never recorded as an unverified auto-confirm.
    expect(
      h.log.all().filter((e) => e.name === "extraction.confirmed" && e.payload["unverified"]),
    ).toEqual([]);
    expect(readManagedRegion(doc.read(docRef)!)).toBe(before);
  });
});
