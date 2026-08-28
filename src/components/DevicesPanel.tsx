import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { cancelDeviceLink, deviceLinkStatus } from "../lib/relay";
import { mintDeviceLink } from "../lib/devices";
import type { LocalIdentity } from "../lib/types";

/**
 * Putting Kin on a second screen of your own — a laptop next to the phone it already lives on.
 *
 * The link carries the identity itself, which makes it the one thing Kin ever puts on screen that
 * would matter if somebody else photographed it. So it says so, plainly, rather than being
 * presented as another invite: an invite that goes astray costs a room, and this one costs
 * everything. It lasts fifteen minutes, it works once, and it can be called off from here.
 */
export default function DevicesPanel({ identity, home, onFlash, onDone }: {
  identity: LocalIdentity;
  home: string | null;
  onFlash(message: string): void;
  onDone(): void;
}) {
  const [link, setLink] = useState<{ code: string; url: string; qr: string; expiresAt: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [minting, setMinting] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  async function mint(): Promise<void> {
    if (minting) return;
    setMinting(true); setFailed(false); setClaimed(false);
    try {
      const made = await mintDeviceLink(identity, home, location.origin);
      const qr = await QRCode.toDataURL(made.link, { margin: 1, width: 260 });
      if (live.current) setLink({ code: made.code, url: made.link, qr, expiresAt: made.expiresAt });
    } catch {
      if (live.current) setFailed(true);
    } finally {
      if (live.current) setMinting(false);
    }
  }

  // Watched rather than assumed: the phone is the only place that can say the link worked, and
  // "did it take?" is the question somebody standing over two devices actually has.
  useEffect(() => {
    if (!link || claimed) return;
    let stop = false;
    const timer = setInterval(async () => {
      if (stop) return;
      try {
        const status = await deviceLinkStatus(identity, link.code);
        if (!stop && status.claimed) { setClaimed(true); clearInterval(timer); }
      } catch { /* expired, or offline for a moment — the next tick asks again */ }
    }, 2000);
    return () => { stop = true; clearInterval(timer); };
  }, [link?.code, claimed, identity.deviceId]);

  async function cancel(): Promise<void> {
    if (!link) return;
    try { await cancelDeviceLink(identity, link.code); } catch { /* it expires by itself anyway */ }
    setLink(null);
    onFlash("Link called off");
  }

  return <>
    <h2>Your devices</h2>
    <p className="sheet-sub">
      Kin can live on more than one screen — your phone and your laptop, the same you in every
      chat. Both hold the same keys, so your family sees one of you and not two.
    </p>

    {claimed ? <>
      <div className="hello-card">🎉<p><b>That device is in.</b> Your groups and chats are on their way over — messages from the last week come with them.</p></div>
      <button className="primary" onClick={onDone}>Lovely</button>
    </> : !link ? <>
      <button className="setting" disabled={minting} onClick={() => void mint()}>
        <span>💻</span>
        <span className="setting-body">
          <strong>{minting ? "One sec…" : "Add another device"}</strong>
          <small>Show a code the other screen can open</small>
        </span>
      </button>
      {failed && <p className="sheet-sub">Couldn’t make a link — are you online?</p>}
    </> : <>
      <img className="qr" src={link.qr} alt="Device link QR code"/>
      <small>Open this on your other device — scan it with its camera, or send yourself the link.</small>
      <div className="pair-actions">
        <button className="chip-btn" onClick={() => { void navigator.clipboard.writeText(link.url); onFlash("Copied — paste it on your other device"); }}>Copy link</button>
        <button className="chip-btn" onClick={() => void navigator.share?.({ title: "Kin", url: link.url }).catch(() => { /* dismissed */ })}>Send it</button>
      </div>
      <p className="sheet-sub">⏳ Good for 15 minutes, and for one device.</p>
      <button className="link" onClick={() => void cancel()}>Call it off</button>
    </>}

    <small className="privacy">
      🔑 This link carries your keys, sealed so the relay cannot read them — the part that opens it
      never leaves your two devices. Treat it like a house key: anyone who opens it becomes you in
      every chat you are in. Removing a device from a room removes all of yours, because to the
      room they are one person.
    </small>
  </>;
}
