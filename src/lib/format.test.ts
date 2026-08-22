import { describe, expect, it } from "vitest";
import { PERSON_COLOURS, dayLabel, emojiOnly, greeting, initials, listStamp, personColour, personIndex, seedEmoji } from "./format";

describe("initials", () => {
  it("takes the first letter of the first two words", () => expect(initials("Sam Holland")).toBe("SH"));
  it("handles a single name", () => expect(initials("Sam")).toBe("S"));
  it("ignores anything past the second word", () => expect(initials("Mary Jane Watson")).toBe("MJ"));
  it("copes with extra whitespace", () => expect(initials("  Sam   Holland ")).toBe("SH"));
  it("falls back to a dot for an empty name", () => expect(initials("   ")).toBe("•"));
});

describe("personIndex", () => {
  const ANIMALS = ["🦊", "🐻", "🐰", "🐸", "🦁", "🐼", "🐨", "🦄", "🐯", "🐙", "🦉", "🐢", "🐬", "🦋", "🐞", "🦕"];

  it("is stable for the same id", () => expect(personIndex("abc")).toBe(personIndex("abc")));

  it("stays inside the palette", () => {
    for (const s of ["", "a", "a very long device id indeed", "🦊"]) {
      expect(personIndex(s)).toBeGreaterThanOrEqual(0);
      expect(personIndex(s)).toBeLessThan(PERSON_COLOURS);
    }
  });

  it("spreads ids that differ only in their last character", () => {
    // The old hash put all of these within one of each other, which is how every avatar in the
    // app ended up the same green.
    const seen = new Set([..."abcdefghijkl"].map(c => personIndex(`device-${c}`)));
    expect(seen.size).toBeGreaterThan(6);
  });

  it("no longer collapses the animal seeds onto one colour", () => {
    // Kept as a regression: these are the exact strings that used to hash to hue 136 or 137.
    const seen = new Set(ANIMALS.map(a => personIndex(`e:${a}`)));
    expect(seen.size).toBeGreaterThan(6);
  });

  it("hands back the custom properties for that index", () => {
    const i = personIndex("device-1");
    expect(personColour("device-1")).toEqual({ bg: `var(--p${i}-bg)`, name: `var(--p${i}-name)` });
  });
});

describe("seedEmoji", () => {
  it("reads a chosen emoji out of the seed", () => expect(seedEmoji("e:🦊")).toBe("🦊"));
  it("returns null for a random seed, so initials are used instead", () => expect(seedEmoji("Ab3xQ")).toBeNull());
});

describe("dayLabel", () => {
  const now = new Date("2026-08-21T15:00:00");
  it("says Today for today", () => expect(dayLabel(new Date("2026-08-21T09:00:00").getTime(), now)).toBe("Today"));
  it("says Yesterday for yesterday", () => expect(dayLabel(new Date("2026-08-20T23:59:00").getTime(), now)).toBe("Yesterday"));
  it("names the day for anything older", () => expect(dayLabel(new Date("2026-08-14T09:00:00").getTime(), now)).toMatch(/Friday/));
  it("rolls back across a month boundary", () => {
    const firstOfMonth = new Date("2026-09-01T10:00:00");
    expect(dayLabel(new Date("2026-08-31T10:00:00").getTime(), firstOfMonth)).toBe("Yesterday");
  });
  it("names the year once the message is from a different one", () => {
    expect(dayLabel(new Date("2025-12-09T10:00:00").getTime(), now)).toMatch(/2025/);
    expect(dayLabel(new Date("2026-08-14T09:00:00").getTime(), now)).not.toMatch(/2026/);
  });
});

describe("listStamp", () => {
  const now = new Date("2026-08-21T15:00:00");
  const at = (iso: string) => listStamp(new Date(iso).getTime(), now);

  it("shows the clock for today", () => expect(at("2026-08-21T09:05:00")).toMatch(/9[:.]05/));
  it("says Yesterday rather than a time", () => expect(at("2026-08-20T23:59:00")).toBe("Yesterday"));
  it("names the weekday inside the last week", () => expect(at("2026-08-17T09:00:00")).toMatch(/Mon/));
  it("falls back to a date past a week", () => {
    const older = at("2026-07-04T09:00:00");
    expect(older).toMatch(/Jul/);
    expect(older).not.toMatch(/2026/);
  });
  it("names the year for a different one", () => expect(at("2025-12-09T10:00:00")).toMatch(/2025/));
  it("does not read as today for anything older", () => {
    // The whole bug: a five-day-old message rendered "4:23 PM" in the conversation list.
    expect(at("2026-08-16T16:23:00")).not.toMatch(/23/);
  });
  it("treats a clock skewed into the future as now", () => expect(at("2026-08-21T23:00:00")).toMatch(/11|23/));
});

describe("emojiOnly", () => {
  it("is true for a lone emoji", () => expect(emojiOnly("🎉")).toBe(true));
  it("is true for a few emoji together", () => expect(emojiOnly("🎉🎉🎉")).toBe(true));
  it("is true for emoji separated by spaces", () => expect(emojiOnly("🎉 🥳")).toBe(true));
  it("is false once there is text", () => expect(emojiOnly("nice 🎉")).toBe(false));
  it("is false for plain text", () => expect(emojiOnly("hello")).toBe(false));
  it("is false for an empty string", () => expect(emojiOnly("")).toBe(false));
  it("is false for a long wall of emoji", () => expect(emojiOnly("🎉🎉🎉🎉🎉🎉🎉")).toBe(false));
  it("handles a multi-codepoint family emoji", () => expect(emojiOnly("👨‍👩‍👧")).toBe(true));
});

describe("greeting", () => {
  const at = (hour: number) => greeting(new Date(2026, 7, 21, hour));
  it("is late at night before five", () => expect(at(3)).toContain("Up late"));
  it("is morning before noon", () => expect(at(9)).toContain("morning"));
  it("is afternoon before six", () => expect(at(14)).toContain("afternoon"));
  it("is evening after six", () => expect(at(21)).toContain("evening"));
  it("switches exactly at the boundaries", () => {
    expect(at(5)).toContain("morning");
    expect(at(12)).toContain("afternoon");
    expect(at(18)).toContain("evening");
  });
});
