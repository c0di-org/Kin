import { useEffect, useRef, useState } from "react";
import Aurora from "./Aurora";

const CRAYONS = ["#241f3d", "#ff5b7f", "#ff9d4d", "#ffd645", "#3fe0b0", "#45c2ff", "#8a7bff", "#ff77bd"];
const SIZES = [5, 11, 22];
const PAPER = "#ffffff";

export default function Doodle({ onSend, onClose }: { onSend(blob: Blob): void; onClose(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(CRAYONS[1]);
  const [size, setSize] = useState(SIZES[1]);
  const [eraser, setEraser] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const undoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const tool = useRef({ color: CRAYONS[1], size: SIZES[1], eraser: false });
  tool.current = { color, size, eraser };

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
  }, []);

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const down = (e: React.PointerEvent): void => {
    e.preventDefault();
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
    g.strokeStyle = t.eraser ? PAPER : t.color;
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

  const clear = (): void => {
    const canvas = canvasRef.current!;
    const g = canvas.getContext("2d")!;
    undoStack.current.push(g.getImageData(0, 0, canvas.width, canvas.height));
    setCanUndo(true);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = PAPER; g.fillRect(0, 0, canvas.width, canvas.height);
    g.restore();
    setDirty(false);
  };

  const send = (): void => {
    canvasRef.current!.toBlob(blob => { if (blob) onSend(blob); }, "image/png");
  };

  return <div className="doodle">
    <Aurora/>
    <header className="doodle-bar">
      <button className="round" onClick={onClose} aria-label="Close">✕</button>
      <strong>Doodle 🖍️</strong>
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
        <button className="primary doodle-send" disabled={!dirty} onClick={send}>Send it! 🚀</button>
      </div>
    </footer>
  </div>;
}
