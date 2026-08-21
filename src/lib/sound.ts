let ctx: AudioContext | null = null;

export function soundsOn(): boolean { return localStorage.getItem("kin:sounds") !== "off"; }
export function setSoundsOn(on: boolean): void { localStorage.setItem("kin:sounds", on ? "on" : "off"); }

function audio(): AudioContext | null {
  if (!soundsOn()) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}

function tone(freq: number, at: number, dur: number, peak: number, type: OscillatorType = "sine"): void {
  const c = audio(); if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  const t = c.currentTime + at;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t); osc.stop(t + dur + 0.05);
}

export const sounds = {
  send(): void { tone(520, 0, 0.12, 0.06); tone(780, 0.05, 0.14, 0.05); },
  receive(): void { tone(660, 0, 0.16, 0.05); tone(880, 0.07, 0.2, 0.04); },
  react(): void { tone(980, 0, 0.1, 0.04); tone(1320, 0.05, 0.14, 0.035); },
  tada(): void { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.25, 0.05, "triangle")); }
};

export function buzz(pattern: number | number[] = 12): void {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
