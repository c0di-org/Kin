import { useEffect, useState } from "react";
import Aurora from "./Aurora";
import { Avatar } from "./Avatar";
import { claimIdentity } from "../lib/devices";
import { firstName } from "../lib/ingest";
import type { DeviceLinkBundle } from "../lib/types";

/**
 * The screen a device link lands on: the second screen, about to become the first one.
 *
 * It collects the bundle before asking anything, for the same reason the invite screen looks the
 * invite up first — "whose Kin is this" is the question somebody staring at a fresh browser has,
 * and answering it is the difference between a handover and a form. Nothing is written until the
 * button is pressed, so a link opened on the wrong machine can simply be walked away from.
 */
export default function LinkDevice({ code, secret, replacing, onAdopt, onCancel }: {
  code: string;
  secret: string;
  /** This browser already has a Kin of its own, and linking would put it aside. */
  replacing: boolean;
  onAdopt(bundle: DeviceLinkBundle): Promise<void>;
  onCancel(): void;
}) {
  const [bundle, setBundle] = useState<DeviceLinkBundle | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = await claimIdentity(code, secret);
        if (live) setBundle(found);
      } catch {
        if (live) setFailed("This link has been used already, or it has run out. Make a fresh one on your other device.");
      }
    })();
    return () => { live = false; };
  }, [code, secret]);

  async function go(): Promise<void> {
    if (!bundle || busy) return;
    setBusy(true);
    try { await onAdopt(bundle); } finally { setBusy(false); }
  }

  return <div className="onboarding">
    <Aurora/>
    <div className="onboard">
      {failed ? <>
        <div className="big-brand"><span className="brand-blob">🕸️</span><strong>Hmm</strong><p>{failed}</p></div>
        <button className="primary" onClick={onCancel}>Go to Kin</button>
      </> : !bundle ? <>
        <div className="big-brand"><span className="brand-blob">🔑</span><strong>Opening…</strong><p>Just a moment.</p></div>
      </> : <>
        <div className="big-brand">
          <span className="brand-blob">💻</span>
          <strong>Hello again, {firstName(bundle.identity.displayName)}</strong>
          <p>This device is about to become another of yours — the same you, in all the same chats.</p>
        </div>
        <div className="invite-from">
          <Avatar member={bundle.identity} size={44}/>
          <span>{bundle.identity.displayName}</span>
        </div>
        <p className="sheet-sub">
          Your groups and private chats come across, along with anything sent in the last week.
          Older messages stay on the device that has them — Kin keeps history on your devices, not
          on the relay.
        </p>
        {replacing && <>
          <div className="hint">
            <strong>⚠️ There is already a Kin on this device</strong>
            <small>Its chats and messages are cleared out, because they belong to a different set of keys. If that Kin is the one you want to keep, stop here.</small>
          </div>
          <button className={`animal ${sure ? "picked" : ""}`} style={{ width: "100%" }} onClick={() => setSure(!sure)}>
            {sure ? "✅ Yes, replace what is here" : "Tap to confirm: replace what is here"}
          </button>
        </>}
        <button className="primary" disabled={busy || (replacing && !sure)} onClick={() => void go()}>
          {busy ? "Bringing it over…" : "Link this device 🔑"}
        </button>
        <button className="link" disabled={busy} onClick={onCancel}>Not this one</button>
      </>}
    </div>
  </div>;
}
