import { useState } from "react";
import Aurora from "./Aurora";

export const ANIMALS = ["🦊", "🐻", "🐰", "🐸", "🦁", "🐼", "🐨", "🦄", "🐯", "🐙", "🦉", "🐢", "🐬", "🦋", "🐞", "🦕"];
const FLOATERS = ["🎈", "⭐", "🦋", "🌈", "🎨", "🧸", "🌻", "🪁", "💌", "🍓"];

export default function Onboarding({ pairCode, create, join }: {
  pairCode: string;
  create(name: string, avatar: string, groupName: string): Promise<void>;
  join(name: string, avatar: string, code: string): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(() => ANIMALS[Math.floor(Math.random() * ANIMALS.length)]);
  const [groupName, setGroupName] = useState("");
  const [code, setCode] = useState(pairCode);
  const [joining, setJoining] = useState(!!pairCode);
  const [busy, setBusy] = useState(false);

  const ok = !!name.trim() && (!joining || code.trim().length >= 6);
  const go = async (): Promise<void> => {
    if (!ok || busy) return;
    setBusy(true);
    try { joining ? await join(name, avatar, code) : await create(name, avatar, groupName.trim() || "Family"); }
    finally { setBusy(false); }
  };

  return <div className="onboarding">
    <Aurora/>
    <div className="floaters" aria-hidden>
      {FLOATERS.map((f, i) => <span key={i} style={{ left: `${(i * 97) % 100}%`, animationDelay: `${i * 1.7}s`, animationDuration: `${14 + (i % 5) * 3}s` }}>{f}</span>)}
    </div>
    <div className="onboard">
      <div className="big-brand">
        <span className="brand-blob">{avatar}</span>
        <strong>Kin</strong>
        <p>A cosy corner for your people — private, playful, and yours.</p>
      </div>
      <label className="onboard-label">Pick your animal</label>
      <div className="animal-grid">
        {ANIMALS.map(a => <button key={a} className={`animal ${avatar === a ? "picked" : ""}`} onClick={() => setAvatar(a)} aria-label={a}>{a}</button>)}
      </div>
      <input autoFocus placeholder="What’s your name?" maxLength={24} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && void go()} />
      {joining
        ? <input className="code-input" placeholder="Invite code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && void go()} />
        : <input placeholder="Name your group — Family, Book club…" maxLength={24} value={groupName} onChange={e => setGroupName(e.target.value)} onKeyDown={e => e.key === "Enter" && void go()} />}
      <button className="primary" disabled={busy || !ok} onClick={() => void go()}>
        {busy ? "One sec…" : joining ? "Join them 🎉" : "Start our group 🎉"}
      </button>
      <button className="link" onClick={() => setJoining(!joining)}>
        {joining ? "Start a new group instead" : "I have an invite code"}
      </button>
    </div>
  </div>;
}
