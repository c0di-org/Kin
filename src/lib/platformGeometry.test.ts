import { describe, expect, it } from "vitest";
import { computeGeometry, type Frame } from "./platformGeometry";

const PHONE = 896;      // screen height in CSS px
const INDICATOR = 34;   // home indicator
const TOOLBAR = 50;     // Safari's bottom toolbar
const KEYBOARD = 340;

const frame = (height: number, bottom: number, top = 47): Frame =>
  ({ height, insets: { top, right: 0, bottom, left: 0 } });
const geometry = (f: Frame, viewportTop: number, viewportHeight: number) =>
  computeGeometry(f, viewportTop, viewportHeight);

describe("computeGeometry", () => {
  it("keeps content off the home indicator in a standalone PWA", () => {
    const g = geometry(frame(PHONE, INDICATOR), 0, PHONE);
    expect(g["--safe-bottom"]).toBe(INDICATOR);
    expect(g["--shell-height"]).toBe(PHONE); // background still owns the whole screen
  });

  it("stands the home indicator down when the keyboard covers it", () => {
    const g = geometry(frame(PHONE, INDICATOR), 0, PHONE - KEYBOARD);
    expect(g["--safe-bottom"]).toBe(KEYBOARD); // the keyboard, not keyboard + indicator
  });

  it("does not pad twice when Safari's toolbar already covers the indicator", () => {
    // Safari reports an inset *and* shrinks the visual viewport for the same strip of screen.
    // Padding for both is what left a dead band under the composer.
    const g = geometry(frame(PHONE, INDICATOR), 0, PHONE - TOOLBAR);
    expect(g["--safe-bottom"]).toBe(TOOLBAR);
    expect(g["--shell-height"]).toBe(PHONE);
  });

  it("reserves the indicator again once Safari's toolbar retracts", () => {
    const g = geometry(frame(PHONE, INDICATOR), 0, PHONE);
    expect(g["--safe-bottom"]).toBe(INDICATOR);
  });

  it("adds nothing when Safari reports no inset and clips fixed layers to the toolbar", () => {
    const g = geometry(frame(PHONE - TOOLBAR, 0), 0, PHONE - TOOLBAR);
    expect(g["--safe-bottom"]).toBe(0);
    expect(g["--shell-height"]).toBe(PHONE - TOOLBAR);
  });

  it("is inert on a desktop window", () => {
    const g = geometry(frame(900, 0, 0), 0, 900);
    expect(g["--safe-bottom"]).toBe(0);
    expect(g["--safe-top"]).toBe(0);
    expect(g["--shell-height"]).toBe(900);
  });

  it("stops padding the top once iOS has scrolled the visual viewport past the notch", () => {
    const g = geometry(frame(PHONE, INDICATOR, 47), 60, PHONE - 60);
    expect(g["--safe-top"]).toBe(0);
    expect(g["--viewport-top"]).toBe(60);
    expect(g["--shell-height"]).toBe(PHONE - 60);
    expect(g["--safe-bottom"]).toBe(INDICATOR);
  });
});
