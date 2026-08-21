const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

const CONFETTI = ["#45c2ff", "#8a7bff", "#ff77bd", "#ff9d4d", "#ffd645", "#3fe0b0", "#ff5b7f"];

export function isCelebration(text: string): boolean {
  return /[🎉🥳🎂🎈🎊🏆⭐🌟]|happy birthday|congrat|hooray|hurra|yay/iu.test(text);
}

/** Full-screen confetti burst rendered on a throwaway canvas. */
export function confetti(): void {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "fx-layer";
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  document.body.appendChild(canvas);
  const g = canvas.getContext("2d")!;
  g.scale(devicePixelRatio, devicePixelRatio);
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.5,
    y: innerHeight * (0.25 + Math.random() * 0.2),
    vx: (Math.random() - 0.5) * 14,
    vy: -6 - Math.random() * 11,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)]
  }));
  const start = performance.now();
  const frame = (now: number): void => {
    const t = (now - start) / 1000;
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.vx *= 0.99; p.r += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r);
      g.fillStyle = p.color; g.globalAlpha = Math.max(0, Math.min(1, 2.4 - t));
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    }
    if (t < 2.6) requestAnimationFrame(frame); else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** A little fountain of one emoji floating up from a point (or bottom-center). */
export function emojiBurst(emoji: string, x?: number, y?: number): void {
  if (reducedMotion()) return;
  const originX = x ?? innerWidth / 2;
  const originY = y ?? innerHeight * 0.75;
  for (let i = 0; i < 9; i++) {
    const span = document.createElement("span");
    span.className = "fx-emoji";
    span.textContent = emoji;
    span.style.left = `${originX + (Math.random() - 0.5) * 90}px`;
    span.style.top = `${originY + (Math.random() - 0.5) * 30}px`;
    span.style.fontSize = `${20 + Math.random() * 22}px`;
    span.style.animationDelay = `${Math.random() * 0.25}s`;
    span.style.animationDuration = `${0.9 + Math.random() * 0.7}s`;
    document.body.appendChild(span);
    setTimeout(() => span.remove(), 2200);
  }
}
