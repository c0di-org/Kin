export type Insets = { top: number; right: number; bottom: number; left: number };

/** The screen a `position: fixed` layer actually gets, plus what env(safe-area-inset-*) resolves to on it. */
export type Frame = { insets: Insets; height: number };

/** One hidden probe answers both questions at once, so the two can never disagree. */
function measureFrame(): Frame {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none;"
    + "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);"
    + "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (v: string): number => Math.max(0, Math.round(parseFloat(v) || 0));
  const frame: Frame = {
    insets: { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) },
    height: Math.round(probe.getBoundingClientRect().height) || window.innerHeight,
  };
  probe.remove();
  return frame;
}

/**
 * Publishes two independent things and never mixes them:
 *
 *   --shell-height / --inset-*   the physical screen. Backgrounds use this and stay safe-area-blind.
 *   --safe-*                     how far content has to stay off each edge *right now*.
 *
 * The bottom is the one everybody gets wrong, because three different things can eat it — the home
 * indicator, the browser's own toolbar and the on-screen keyboard — and they overlap rather than
 * stack. So instead of guessing which is in play (standalone? tab? keyboard?) we measure where the
 * browser stops showing us pixels and compare that against where the home indicator starts.
 * Whichever bites first wins, once. That is what kills the double padding: --safe-bottom is already
 * the final answer, so no rule downstream ever adds or subtracts an inset again.
 */
export function computeGeometry(frame: Frame, viewportTop: number, viewportHeight: number): Record<string, number> {
  const { insets } = frame;
  const screen = Math.max(frame.height, viewportTop + viewportHeight);
  // The last row of pixels the browser is actually showing us: top of the keyboard, top of the
  // browser's toolbar, or the bottom of the screen — whichever comes first.
  const shown = Math.min(screen, viewportTop + viewportHeight);
  // The last row content may sit on without the home indicator crossing it.
  const clear = screen - insets.bottom;
  return {
    "--inset-top": insets.top,
    "--inset-right": insets.right,
    "--inset-bottom": insets.bottom,
    "--inset-left": insets.left,
    // measured from the bottom of the shell, which is the bottom of the screen
    "--safe-bottom": Math.max(0, screen - Math.min(shown, clear)),
    "--safe-top": Math.max(0, insets.top - viewportTop),
    "--safe-left": insets.left,
    "--safe-right": insets.right,
    "--app-height": viewportHeight,
    "--shell-height": Math.max(0, screen - viewportTop),
    "--viewport-top": viewportTop,
    // whatever the browser took off the bottom on top of the safe area — the keyboard, in practice
    "--keyboard-inset": Math.max(0, screen - shown - insets.bottom),
  };
}

function update(): void {
  const style = document.documentElement.style;
  const frame = measureFrame();
  const vv = window.visualViewport;
  const geometry = computeGeometry(frame, Math.max(0, Math.round(vv?.offsetTop ?? 0)), Math.round(vv?.height ?? frame.height));
  for (const [name, value] of Object.entries(geometry)) style.setProperty(name, `${value}px`);
}

export function installPlatformGeometry(): () => void {
  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  return () => {
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
  };
}
