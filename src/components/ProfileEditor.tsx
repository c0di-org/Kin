import { useState } from "react";
import type { LocalIdentity } from "../lib/types";
import { seedEmoji } from "../lib/format";
import { ANIMALS } from "./Onboarding";

/** Name-and-animal editor, shared by onboarding and settings. */
export function ProfileEditor({ identity, onSave, onCancel }: { identity: LocalIdentity; onSave(name: string, avatar: string): void; onCancel(): void }) {
  const [name, setName] = useState(identity.displayName);
  const [avatar, setAvatar] = useState(() => seedEmoji(identity.avatarSeed) ?? ANIMALS[0]);
  const changed = name.trim() !== identity.displayName || `e:${avatar}` !== identity.avatarSeed;
  return <>
    <h2>Your look</h2>
    <div className="profile-preview"><span className="brand-blob">{avatar}</span></div>
    <label className="onboard-label">Pick your animal</label>
    <div className="animal-grid">
      {ANIMALS.map(a => <button key={a} className={`animal ${avatar === a ? "picked" : ""}`} onClick={() => setAvatar(a)} aria-label={a}>{a}</button>)}
    </div>
    <label className="onboard-label">Your name</label>
    <input className="name-input" placeholder="What’s your name?" maxLength={24} value={name}
      onChange={e => setName(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter" && name.trim()) onSave(name, avatar); }}/>
    <div className="profile-actions">
      <button className="chip-btn" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={!name.trim() || !changed} onClick={() => onSave(name, avatar)}>Save ✨</button>
    </div>
  </>;
}

