import { describe, expect, it } from "vitest";
import { dayLabel, emojiOnly, greeting, hue, initials, seedEmoji } from "./format";

describe("initials", () => {
  it("takes the first letter of the first two words", () => expect(initials("Sam Holland")).toBe("SH"));
  it("handles a single name", () => expect(initials("Sam")).toBe("S"));
  it("ignores anything past the second word", () => expect(initials("Mary Jane Watson")).toBe("MJ"));
  it("copes with extra whitespace", () => expect(initials("  Sam   Holland ")).toBe("SH"));
  it("falls back to a dot for an empty name", () => expect(initials("   ")).toBe("•"));
});

describe("hue", () => {
  it("is stable for the same seed", () => expect(hue("abc")).toBe(hue("abc")));
  it("stays inside the colour wheel", () => {
    for (const s of ["", "a", "a very long avatar seed indeed", "🦊"]) {
      expect(hue(s)).toBeGreaterThanOrEqual(0);
      expect(hue(s)).toBeLessThan(360);
    }
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
