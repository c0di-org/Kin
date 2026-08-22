import { useEffect, useState } from "react";
import Aurora from "./Aurora";
import { Avatar } from "./Avatar";
import { anonymousProfile, lookUpInvite } from "../lib/spaces";
import { firstName } from "../lib/ingest";
import type { InvitePreview } from "../lib/types";

export const ANIMALS = ["🦊", "🐻", "🐰", "🐸", "🦁", "🐼", "🐨", "🦄", "🐯", "🐙", "🦉", "🐢", "🐬", "🦋", "🐞", "🦕"];

/**
 * The screen an invite link lands on.
 *
 * It looks the invite up before asking for anything, because "who is inviting me where" is the
 * question somebody clicking an unknown link actually has, and answering it first is the
 * difference between an invitation and a form. Only once that is on screen does it ask for a
 * name — and offers to skip that too, since half the point of a link invite is letting somebody
 * see the photos without signing up to be known.
 */
export default function JoinInvite({ code, onAccept, onCancel }: {
  code: string;
  onAccept(preview: InvitePreview, profile: { displayName: string; avatarSeed: string }): Promise<void>;
  onCancel(): void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [failed, setFailed] = useState("");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(() => ANIMALS[Math.floor(Math.random() * ANIMALS.length)]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = await lookUpInvite(code);
        if (live) setPreview(found);
      } catch {
        if (live) setFailed("This link has expired, or it was never quite right. Ask for a fresh one.");
      }
    })();
    return () => { live = false; };
  }, [code]);

  async function go(anonymous: boolean): Promise<void> {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await onAccept(preview, anonymous
        ? anonymousProfile()
        : { displayName: name.trim().slice(0, 32), avatarSeed: `e:${avatar}` });
    } finally { setBusy(false); }
  }

  return <div className="onboarding">
    <Aurora/>
    <div className="onboard">
      {failed ? <>
        <div className="big-brand"><span className="brand-blob">🕸️</span><strong>Hmm</strong><p>{failed}</p></div>
        <button className="primary" onClick={onCancel}>Go to Kin</button>
      </> : !preview ? <>
        <div className="big-brand"><span className="brand-blob">🔗</span><strong>Opening…</strong><p>Just a moment.</p></div>
      </> : <>
        <div className="big-brand">
          <span className="brand-blob">{preview.role === "viewer" ? "👀" : "💌"}</span>
          <strong>{preview.room.title}</strong>
          <p>
            <b>{firstName(preview.inviter.displayName)}</b> invited you
            {preview.role === "viewer" ? " to take a look." : " to join in."}
          </p>
        </div>
        <div className="invite-from">
          <Avatar member={preview.inviter} size={44}/>
          <span>{preview.inviter.displayName}</span>
        </div>

        <label className="onboard-label">Pick your animal</label>
        <div className="animal-grid">
          {ANIMALS.map(a => <button key={a} className={`animal ${avatar === a ? "picked" : ""}`} onClick={() => setAvatar(a)} aria-label={a}>{a}</button>)}
        </div>
        <input autoFocus placeholder="What should they call you?" maxLength={24} value={name}
          onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && void go(false)}/>

        <button className="primary" disabled={busy || !name.trim()} onClick={() => void go(false)}>
          {busy ? "One sec…" : preview.role === "viewer" ? "Take a look 👀" : "Join in 🎉"}
        </button>
        <button className="link" disabled={busy} onClick={() => void go(true)}>Go in without a name</button>
        <button className="link" disabled={busy} onClick={onCancel}>Not now</button>
      </>}
    </div>
  </div>;
}
