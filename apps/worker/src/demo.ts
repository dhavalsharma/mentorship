import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  commitRosterImport,
  planRosterImport,
  renderPlan,
} from "@mentorship/roster";
import type { TraceLine } from "@mentorship/workflows";
import {
  advanceToNextTimer,
  bootstrap,
  DEMO_PROFILE,
  type Harness,
} from "@mentorship/testkit";

/**
 * End-to-end walk-through, no database and no model.
 *
 *   Part 1 — an admin uploads a spreadsheet of pairs that already exist.
 *   Part 2 — one of those pairs runs a complete session cycle and loops.
 *
 * Run with: pnpm demo
 */

const ROSTER = fileURLToPath(
  new URL("../../../examples/roster-pairs.csv", import.meta.url),
);

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun.rao@wekancode.com,Arjun Rao,priya.menon@wekancode.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

// Arjun already has a standing commitment first thing on the Monday.
const BUSY = {
  "arjun.rao@wekancode.com": [
    { start: "2026-09-14T03:30:00.000Z", end: "2026-09-14T05:00:00.000Z" },
  ],
  "priya.menon@wekancode.com": [
    { start: "2026-09-14T06:00:00.000Z", end: "2026-09-14T07:00:00.000Z" },
  ],
};

function heading(text: string): void {
  console.log(`\n${"═".repeat(74)}\n${text}\n${"═".repeat(74)}`);
}

function step(text: string): void {
  console.log(`\n── ${text} ${"─".repeat(Math.max(0, 70 - text.length))}`);
}

function makeDrain(h: Harness) {
  let seen = 0;
  return function drain(): void {
    for (const call of h.recorder.calls.slice(seen)) {
      const detail = Object.entries(call.detail)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}=${format(v)}`)
        .join(" ");
      console.log(`    ↳ ${call.kind.padEnd(20)} ${detail}`);
    }
    seen = h.recorder.calls.length;
  };
}

function format(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(String).join(" | ")}]`;
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function traceLine(clockIso: () => string) {
  return (line: TraceLine): void => {
    const when = clockIso().slice(0, 16).replace("T", " ");
    const effects =
      line.effects.length > 0 ? `  effects: ${line.effects.join(", ")}` : "";
    console.log(
      `  [${when}] ${line.input.padEnd(22)} ${line.from} → ${line.to}${effects}`,
    );
  };
}

// ---------------------------------------------------------------------------

async function part1(): Promise<void> {
  heading("PART 1 — Pairing is optional: importing a roster of existing pairs");

  const h = bootstrap({ onWarn: () => {} });
  console.log(`\nProgram pairing mode: ${h.policy.pairing.mode}`);
  console.log("Integration profile:");
  for (const [slot, adapter] of Object.entries(DEMO_PROFILE)) {
    console.log(`  ${slot.padEnd(14)} ${adapter ?? "— (degraded path)"}`);
  }

  step("Dry run — nothing is written yet");
  const csv = readFileSync(ROSTER, "utf8");
  const plan = planRosterImport(csv, {
    policy: h.policy,
    existing: {
      participantsByEmail: h.world.participantsByEmail(),
      pairKeys: h.world.pairKeys(),
      mentorLoad: h.world.mentorLoad(),
    },
    defaultTzOffsetMinutes: 330,
  });
  console.log(renderPlan(plan));

  step("Commit the good rows (errors waived by the admin)");
  const result = await commitRosterImport(plan, h.world, {
    importedPairsStart: h.policy.pairing.importedPairsStart,
    allowPartial: true,
  });
  await h.dispatcher.settle();

  console.log(
    `Created ${result.created.length} pairings and ${result.peopleCreated} people.`,
  );
  const instances = await h.engine.instances();
  console.log(
    `Sagas started automatically from pair.activated: ${instances.length}`,
  );
  console.log(
    "Every one of them carries origin='imported' — and nothing downstream can tell,",
  );
  console.log(
    "because a matched pair would have emitted exactly the same event.",
  );

  step("Re-uploading the same file is safe");
  const second = planRosterImport(csv, {
    policy: h.policy,
    existing: {
      participantsByEmail: h.world.participantsByEmail(),
      pairKeys: h.world.pairKeys(),
      mentorLoad: h.world.mentorLoad(),
    },
    defaultTzOffsetMinutes: 330,
  });
  console.log(
    `Second pass: ${second.summary.pairsToCreate} to create, ${second.summary.skipped} skipped as already present.`,
  );
}

// ---------------------------------------------------------------------------

async function part2(): Promise<void> {
  heading("PART 2 — One pair, one full session cycle, then the loop closes");

  const warnings: string[] = [];
  let clockRef = () => "";
  const harness = bootstrap({
    busy: BUSY,
    transcriptAvailableAfter: 2, // the first poll misses, so the backoff shows
    onTrace: traceLine(() => clockRef()),
    onWarn: (m) => warnings.push(m),
  });
  clockRef = () => harness.clock.iso();
  const drain2 = makeDrain(harness);

  step("Import one pair and let the saga start");
  const plan = planRosterImport(ONE_PAIR, {
    policy: harness.policy,
    defaultTzOffsetMinutes: 330,
  });
  const committed = await commitRosterImport(plan, harness.world, {
    importedPairsStart: "active",
  });
  const pairingId = committed.created[0]!.pairingId;
  await harness.dispatcher.settle();
  drain2();

  step("Both parties pick the second option");
  const agreement = harness.world.latestAgreementFor(pairingId)!;
  const chosen = agreement.options[1]!;
  console.log(`  offered: ${agreement.options.map((o) => o.label).join("  |  ")}`);
  console.log(`  chosen:  ${chosen.label}`);
  for (const participantId of agreement.participantIds) {
    await harness.world.respond(
      agreement.id,
      participantId,
      "accept",
      chosen.optionId,
    );
  }
  await harness.dispatcher.settle();
  drain2();

  step("Time passes — the reminder timer fires");
  await advanceToNextTimer(harness);
  drain2();

  step("The meeting ends — transcript polling with backoff");
  await advanceToNextTimer(harness); // first poll: not there yet
  drain2();
  await advanceToNextTimer(harness); // second poll: found, extract, render, post
  drain2();

  step("Both confirm the write-up");
  for (const participantId of agreement.participantIds) {
    await harness.world.confirmExtraction(pairingId, participantId);
  }
  await harness.dispatcher.settle();
  drain2();

  step("Feedback comes back privately, one question each");
  for (const [i, participantId] of agreement.participantIds.entries()) {
    await harness.world.submitFeedback(pairingId, participantId, 4 + (i % 2));
  }
  await harness.dispatcher.settle();
  drain2();

  step("A fortnight later — cooling expires and the next session is proposed");
  const wokeAt = await advanceToNextTimer(harness);
  console.log(`  woke at ${wokeAt} (agreed frequency, minus the propose lead)`);
  drain2();

  step("Where the saga ended up");
  const [instance] = await harness.engine.instances();
  console.log(`  state:   ${JSON.stringify(instance!.state)}`);
  console.log(`  steps:   ${instance!.stepIndex}`);
  console.log(`  version: ${instance!.version}`);
  console.log(
    `  history: ${instance!.history.map((entry) => entry.to).join(" → ")}`,
  );

  const events = harness.log.all();
  console.log(`\n  ${events.length} domain events written, in order:`);
  console.log(
    `  ${events.map((e) => e.name).join(", ")}`,
  );
  if (harness.log.deadLetters.length > 0) {
    console.log(`  dead letters: ${harness.log.deadLetters.length}`);
  }
}

// ---------------------------------------------------------------------------

async function part3(): Promise<void> {
  heading("PART 3 — The same saga on a tenant with no transcription");

  const warnings: string[] = [];
  const h = bootstrap({
    busy: BUSY,
    // A tenant whose edition or admin policy gives no automatic transcript.
    transcription: "none",
    omitSlots: ["document"],
    onWarn: (m) => warnings.push(m),
  });

  const plan = planRosterImport(ONE_PAIR, {
    policy: h.policy,
    defaultTzOffsetMinutes: 330,
  });
  const committed = await commitRosterImport(plan, h.world, {
    importedPairsStart: "active",
  });
  const pairingId = committed.created[0]!.pairingId;
  await h.dispatcher.settle();

  const agreement = h.world.latestAgreementFor(pairingId)!;
  for (const participantId of agreement.participantIds) {
    await h.world.respond(
      agreement.id,
      participantId,
      "accept",
      agreement.options[0]!.optionId,
    );
  }
  await h.dispatcher.settle();
  await advanceToNextTimer(h); // reminder
  await advanceToNextTimer(h); // meeting ends

  const [instance] = await h.engine.instances();
  const state = instance!.state as { name: string; mode?: string };
  console.log(
    `\nAfter the meeting the saga is in ${state.name}/${state.mode} —`,
  );
  console.log(
    "it never polls for a transcript that was never going to exist, and asks",
  );
  console.log("for notes instead. Same saga, different integration profile.\n");

  await h.world.submitNotes(
    pairingId,
    "Arjun: send me the draft by Friday.\nPriya: I'll write up the billing migration.",
  );
  await h.dispatcher.settle();

  const after = (await h.engine.instances())[0]!;
  console.log(`Notes submitted → ${(after.state as { name: string }).name}`);
  console.log(
    `Document slot was empty, so the write-up went to an internal page:`,
  );
  const rendered = h.log
    .all()
    .filter((e) => e.name === "document.rendered")
    .map((e) => e.payload["url"]);
  console.log(`  ${rendered.join(", ")}`);
  if (warnings.length > 0) {
    console.log(`\nDegradation warnings logged (not errors):`);
    for (const w of new Set(warnings)) console.log(`  • ${w}`);
  }
}

// ---------------------------------------------------------------------------

await part1();
await part2();
await part3();

console.log(
  `\n${"═".repeat(74)}\nNothing above touched a database, a network, or a model.\n${"═".repeat(74)}\n`,
);
