import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import {
  loadVendorFixtures,
  VendorReplay,
  type VendorFixture,
} from "@mentorship/integrations";

/**
 * Shared by every adapter test that replays vendor fixtures. DATA/HELPER ONLY
 * — deliberately not `*.test.ts`.
 *
 * Call `warnOnStaleFixtures()` once at the top of a test file: after the file
 * runs, every fixture it was actually answered from that is hand-written or
 * older than `VENDOR_FIXTURE_MAX_AGE_DAYS` (default 90) is named in a warning.
 * A warning, never a failure — a stale fixture is a reason to run the live
 * contract suite, not a reason the diff in front of you is wrong.
 */

export const VENDOR_FIXTURE_DIR = fileURLToPath(
  new URL("../../../../tests/fixtures/vendor", import.meta.url),
);

let cache: VendorFixture[] | undefined;
export function vendorFixtures(): VendorFixture[] {
  cache ??= loadVendorFixtures(VENDOR_FIXTURE_DIR);
  return cache;
}

const opened: VendorReplay[] = [];

export function openReplay(): VendorReplay {
  const replay = new VendorReplay(vendorFixtures());
  opened.push(replay);
  return replay;
}

export function maxFixtureAgeDays(): number {
  const raw = Number(process.env["VENDOR_FIXTURE_MAX_AGE_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

export function warnOnStaleFixtures(label: string): void {
  afterAll(() => {
    const seen = new Map<VendorFixture, string[]>();
    for (const replay of opened) {
      for (const { fixture, staleness } of replay.staleServed({ maxAgeDays: maxFixtureAgeDays() })) {
        seen.set(fixture, staleness.reasons);
      }
    }
    if (seen.size === 0) return;
    const lines = [...seen].map(
      ([f, reasons]) =>
        `  ${f.vendor}/${f.call}${f.variant ? `--${f.variant}` : ""} (${f.capturedOn}): ${reasons.join("; ")}`,
    );
    console.warn(
      `[vendor-fixtures] ${label} replayed ${seen.size} unverified fixture(s) — run pnpm test:contracts:live to replace them:\n${lines.join("\n")}`,
    );
  });
}
