import { describe, expect, it } from "vitest";
import { parseGrantStaffArgs, type GrantStaffInput } from "../staff-grants.js";

/** `pnpm staff:grant`'s argv, apart from the database write it drives. */
describe("parseGrantStaffArgs", () => {
  it("reads --flag value and --flag=value", () => {
    expect(parseGrantStaffArgs(["--email", "a@b.co", "--role=admin", "--name", "Ada L"])).toEqual({
      ok: true,
      email: "a@b.co",
      staffRole: "admin",
      displayName: "Ada L",
    });
    expect(parseGrantStaffArgs(["--email=a@b.co", "--role", "program_lead"])).toEqual({
      ok: true,
      email: "a@b.co",
      staffRole: "program_lead",
    });
  });

  it("--role none clears, and is the only way to — an absent --role is an error", () => {
    expect(parseGrantStaffArgs(["--email", "a@b.co", "--role", "none"])).toMatchObject({
      ok: true,
      staffRole: null,
    });
    expect(parseGrantStaffArgs(["--email", "a@b.co"])).toMatchObject({ ok: false });
  });

  it("refuses a pair role, an unknown role, an unknown flag and a missing value", () => {
    for (const argv of [
      ["--email", "a@b.co", "--role", "mentee"],
      ["--email", "a@b.co", "--role", "owner"],
      ["--email", "a@b.co", "--role", "admin", "--org", "x"],
      ["--email", "--role", "admin"],
      ["--role", "admin"],
      ["a@b.co", "--role", "admin"],
    ]) {
      expect(parseGrantStaffArgs(argv).ok).toBe(false);
    }
  });
});

describe("GrantStaffInput", () => {
  it("a guarded (dashboard) grant cannot be written without the actor it re-checks", () => {
    const base = { orgId: "o", email: "a@b.co", staffRole: "admin" } as const;
    const guarded: GrantStaffInput = {
      ...base,
      actorType: "admin",
      actorRef: "user-1",
      protectLastAdmin: true,
    };
    // @ts-expect-error — `protectLastAdmin: true` requires `actorRef`
    const noActor: GrantStaffInput = { ...base, actorType: "admin", protectLastAdmin: true };
    // @ts-expect-error — nor may the guarded path's actor be null
    const nullActor: GrantStaffInput = { ...base, actorType: "admin", actorRef: null, protectLastAdmin: true };
    // The CLI's operator path needs neither.
    const operator: GrantStaffInput = { ...base };
    expect([guarded, noActor, nullActor, operator]).toHaveLength(4);
  });
});
