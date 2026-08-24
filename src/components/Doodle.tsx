import { useEffect, useRef, useState } from "react";
import Aurora from "./Aurora";

const CRAYONS = ["#241f3d", "#ff5b7f", "#ff9d4d", "#ffd645", "#3fe0b0", "#45c2ff", "#8a7bff", "#ff77bd"];
const SIZES = [5, 11, 22];
const PAPER = "#ffffff";

/**
 * The drawing pad, optionally started on top of somebody else's picture.
 *
 * `backdrop` is an object URL for an image already on this device — a photo or a doodle from the
 * thread. It is painted onto the canvas rather than sat behind it, so what gets sent is one flat
 * picture: the recipient does not need the original to see what was drawn on, and doodling back
 * onto a doodle-back keeps working however many rounds in it goes.
 */
export default function Doodle({ backdrop, onSend, onClose }: { backdrop?: string; onSend(blob: Blob): void; onClose(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(CRAYONS[1]);
  const [size, setSize] = useState(SIZES[1]);
  const [eraser, setEraser] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  // Drawing before the picture has been painted would put the strokes under it.
  const [loaded, setLoaded] = useState(!backdrop);
  const undoStack = useRef<ImageData[]>([]);
  /**
   * The picture we started from — blank paper, or somebody else's photo — held as its own canvas.
   *
   * It is what "start over" goes back to, kept apart from the undo stack because that stack is
   * capped and drops its oldest entry: after thirty strokes the bottom of it is no longer the
   * picture we began with. It is also what the eraser paints *with*, so rubbing something out over
   * a photo brings the photo back rather than punching a white hole in it.
   */
  const base = useRef<HTMLCanvasElement | null>(null);
  const eraseWith = useRef<CanvasPattern | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const tool = useRef({ color: CRAYONS[1], size: SIZES[1], eraser: false });
  tool.current = { color, size, eraser };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const g = canvas.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = PAPER;
    g.fillRect(0, 0, rect.width, rect.height);
    g.lineCap = "round";
    g.lineJoin = "round";
    const keepBase = (): void => {
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext("2d")!.drawImage(canvas, 0, 0);
      base.current = copy;
      const pattern = g.createPattern(copy, "no-repeat");
      // The context is scaled by the device ratio; the pattern is in device pixels, so it has to be
      // scaled back down or the backdrop comes out of the eraser twice the size it went in.
      pattern?.setTransform(new DOMMatrix().scale(1 / dpr));
      eraseWith.current = pattern;
    };
    if (!backdrop) { keepBase(); return; }
    // Fitted rather than filled: cropping somebody's photo to the shape of this phone's screen
    // would cut off the very thing they are being asked to draw on.
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const scale = Math.min(rect.width / img.width, rect.height / img.height);
      const w = img.width * scale, h = img.height * scale;
      g.drawImage(img, (rect.width - w) / 2, (rect.height - h) / 2, w, h);
      keepBase();
      setLoaded(true);
    };
    img.onerror = () => { if (live) { keepBase(); setLoaded(true); } };
    img.src = backdrop;
    return () => { live = false; };
  }, [backdrop]);

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const down = (e: React.PointerEvent): void => {
    e.preventDefault();
    if (!loaded) return;
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    const g = canvas.getContext("2d")!;
    undoStack.current.push(g.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.current.length > 30) undoStack.current.shift();
    setCanUndo(true);
    drawing.current = true;
    last.current = point(e);
    drawTo(point(e));
  };

  const drawTo = (p: { x: number; y: number }): void => {
    const g = canvasRef.current!.getContext("2d")!;
    const t = tool.current;
    g.strokeStyle = t.eraser ? (eraseWith.current ?? PAPER) : t.color;
    g.lineWidth = t.eraser ? t.size * 2.6 : t.size;
    g.beginPath();
    const from = last.current ?? p;
    g.moveTo(from.x, from.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
    setDirty(true);
  };

  const move = (e: React.PointerEvent): void => { if (drawing.current) drawTo(point(e)); };
  const up = (): void => { drawing.current = false; last.current = null; };

  const undo = (): void => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    const g = canvasRef.current!.getContext("2d")!;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(snap, 0, 0); g.restore();
    setCanUndo(undoStack.current.length > 0);
  };

  // Start over means "back to how I found it": over somebody's photo that is the photo, not a
  // blank sheet, which would silently throw away the thing being drawn on.
  const clear = (): void => {
    const canvas = canvasRef.current!;
    const g = canvas.getContext("2d")!;
    undoStack.current.push(g.getImageData(0, 0, canvas.width, canvas.height));
    setCanUndo(true);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (base.current) g.drawImage(base.current, 0, 0);
    else { g.fillStyle = PAPER; g.fillRect(0, 0, canvas.width, canvas.height); }
    g.restore();
    setDirty(false);
  };

  const send = (): void => {
    canvasRef.current!.toBlob(blob => { if (blob) onSend(blob); }, "image/png");
  };

  return <div className="doodle" role="dialog" aria-modal="true" aria-label="Doodle">
    <Aurora/>
    <header className="doodle-bar">
      <button className="round doodle-close" onClick={onClose} aria-label="Close doodle">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>
      </button>
      <strong>{backdrop ? "Doodle back 🖍️" : "Doodle 🖍️"}</strong>
      <div className="doodle-bar-actions">
        <button className="round" onClick={undo} disabled={!canUndo} aria-label="Undo">↩︎</button>
        <button className="round" onClick={clear} aria-label="Start over">🗑</button>
      </div>
    </header>
    <canvas ref={canvasRef} className="doodle-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
    <footer className="doodle-tools">
      <div className="crayons">
        {CRAYONS.map(c => <button key={c} className={`crayon ${!eraser && color === c ? "picked" : ""}`} style={{ background: c }} aria-label={`Crayon ${c}`} onClick={() => { setColor(c); setEraser(false); }} />)}
        <button className={`crayon eraser ${eraser ? "picked" : ""}`} aria-label="Eraser" onClick={() => setEraser(true)}>◻︎</button>
      </div>
      <div className="doodle-send-row">
        <div className="brush-sizes">
          {SIZES.map(s => <button key={s} className={`brush ${size === s ? "picked" : ""}`} aria-label={`Brush ${s}`} onClick={() => setSize(s)}><i style={{ width: 4 + s, height: 4 + s }} /></button>)}
        </div>
        <button className="primary doodle-send" disabled={!dirty} onClick={send}>{backdrop ? "Send it back! 🚀" : "Send it! 🚀"}</button>
      </div>
    </footer>
  </div>;
}
