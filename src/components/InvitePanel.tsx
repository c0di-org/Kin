import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { listInvites, revokeInvite } from "../lib/relay";
import { DEFAULT_INVITE_TTL, mintInvite } from "../lib/spaces";
import { publicMember } from "../lib/crypto";
import type { Conversation, InviteRole, InviteSummary, LocalIdentity } from "../lib/types";

const DAY = 24 * 60 * 60 * 1000;

const ROLES: { value: InviteRole; label: string; hint: string; emoji: string }[] = [
  { value: "guest", label: "Can join in", hint: "Read and post, but can't invite anyone else", emoji: "💬" },
  { value: "viewer", label: "Can look", hint: "See everything, post nothing", emoji: "👀" }
];

const REACH: { label: string; maxUses: number | null }[] = [
  { label: "One person", maxUses: 1 },
  { label: "A few", maxUses: 10 },
  { label: "Anyone with the link", maxUses: null }
];

const LIFE: { label: string; ttl: number }[] = [
  { label: "A day", ttl: DAY },
  { label: "A week", ttl: DEFAULT_INVITE_TTL },
  { label: "A month", ttl: 30 * DAY }
];

function until(at: number): string {
  const left = at - Date.now();
  if (left <= 0) return "expired";
  const days = Math.round(left / DAY);
  if (days >= 1) return days === 1 ? "1 day left" : `${days} days left`;
  const hours = Math.max(1, Math.round(left / (60 * 60 * 1000)));
  return hours === 1 ? "1 hour left" : `${hours} hours left`;
}

/**
 * Make a link to this conversation, and manage the ones already out there.
 *
 * The shape of the choice matters more than it looks. An invite is a capability — whoever holds
 * the link can walk in — so the two questions worth putting in front of someone before they share
 * one are how many people it should let in and how long it should keep working. Both default
 * tight (one person, a week) rather than convenient, because the convenient end of each is the
 * one you cannot take back once the link is in a group chat somewhere.
 */
export function InvitePanel({ identity, conversation, onFlash }: {
  identity: LocalIdentity;
  conversation: Conversation;
  onFlash(message: string): void;
}) {
  const [role, setRole] = useState<InviteRole>("guest");
  const [reach, setReach] = useState(0);
  const [life, setLife] = useState(1);
  const [made, setMade] = useState<{ link: string; qr: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outstanding, setOutstanding] = useState<InviteSummary[]>([]);

  async function refreshOutstanding(): Promise<void> {
    try { setOutstanding(await listInvites(identity, conversation.id)); }
    catch { /* offline, or not ours to see — the list simply stays as it was */ }
  }
  useEffect(() => { void refreshOutstanding(); }, [conversation.id]);

  async function make(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const invite = await mintInvite(identity, conversation, {
        role, maxUses: REACH[reach].maxUses, ttl: LIFE[life].ttl
      });
      setMade({
        link: invite.link,
        expiresAt: invite.expiresAt,
        qr: await QRCode.toDataURL(invite.link, { margin: 1, width: 260 })
      });
      void refreshOutstanding();
    } catch {
      onFlash("Couldn’t make a link — are you online?");
    } finally { setBusy(false); }
  }

  async function share(): Promise<void> {
    if (!made) return;
    const text = `Come join ${conversation.title} on Kin`;
    try {
      if (navigator.share) await navigator.share({ title: conversation.title, text, url: made.link });
      else { await navigator.clipboard.writeText(made.link); onFlash("Link copied!"); }
    } catch { /* dismissed */ }
  }

  async function kill(code: string): Promise<void> {
    try {
      await revokeInvite(identity, code, publicMember(identity));
      setOutstanding(x => x.filter(i => i.code !== code));
      if (made) setMade(null);
      onFlash("That link won’t work any more");
    } catch { onFlash("Couldn’t turn that link off"); }
  }

  if (made) return <>
    <div className="sheet-title"><h2>Here’s your link 🔗</h2></div>
    <img className="pair-qr" src={made.qr} alt="Scan to join"/>
    <p className="pair-hint">
      Anyone who opens this can {role === "viewer" ? "look at" : "join"} <b>{conversation.title}</b>.
      {" "}{REACH[reach].maxUses === 1 ? "It works once." : REACH[reach].maxUses === null ? "It has no limit." : `Up to ${REACH[reach].maxUses} people.`}
      {" "}{until(made.expiresAt)}.
    </p>
    <button className="primary" onClick={() => void share()}>Send it 💌</button>
    <button className="link" onClick={() => setMade(null)}>Make another</button>
  </>;

  return <>
    <div className="sheet-title"><h2>Invite to {conversation.title}</h2></div>

    <label className="onboard-label">What can they do?</label>
    <div className="choice-row">
      {ROLES.map(r => <button key={r.value} className={`choice ${role === r.value ? "picked" : ""}`} onClick={() => setRole(r.value)}>
        <span>{r.emoji}</span><strong>{r.label}</strong><small>{r.hint}</small>
      </button>)}
    </div>

    <label className="onboard-label">Who’s it for?</label>
    <div className="pill-row">
      {REACH.map((r, i) => <button key={r.label} className={`pill ${reach === i ? "picked" : ""}`} onClick={() => setReach(i)}>{r.label}</button>)}
    </div>

    <label className="onboard-label">How long should it work?</label>
    <div className="pill-row">
      {LIFE.map((l, i) => <button key={l.label} className={`pill ${life === i ? "picked" : ""}`} onClick={() => setLife(i)}>{l.label}</button>)}
    </div>

    <button className="primary" disabled={busy} onClick={() => void make()}>{busy ? "One sec…" : "Make a link 🔗"}</button>

    {outstanding.length > 0 && <>
      <label className="onboard-label">Links you’ve shared</label>
      {outstanding.map(i => <div key={i.code} className="member">
        <span className="member-emoji">{i.role === "viewer" ? "👀" : "💬"}</span>
        <span>
          <strong>{i.maxUses === null ? "Open link" : i.maxUses === 1 ? "One person" : `Up to ${i.maxUses}`}</strong>
          <small>{i.uses} used · {until(i.expiresAt)}</small>
        </span>
        <button className="danger-link" onClick={() => void kill(i.code)}>Turn off</button>
      </div>)}
    </>}
  </>;
}
