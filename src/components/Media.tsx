import { useEffect, useRef, useState } from "react";
import type { AttachmentPayload, Conversation, LocalIdentity } from "../lib/types";
import { cachedUrl, fmtDuration, fmtSize, mediaKind, resolveAttachment, saveToDevice, shareFile } from "../lib/media";

type Gone = { failed: boolean; permanent: boolean; onRetry(): void };
const goneNote = (permanent: boolean): string => permanent ? "Ask them to send it again" : "Tap to try again";

export function useAttachmentUrl(identity: LocalIdentity, conversation: Conversation, att: AttachmentPayload): Gone & { url: string | null } {
  const [url, setUrl] = useState<string | null>(() => cachedUrl(att.fileId));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (url) return;
    let live = true;
    setFailed(false);
    void resolveAttachment(identity, conversation, att).then(u => {
      if (!live) return;
      if (u) setUrl(u); else setFailed(true);
    });
    return () => { live = false; };
  }, [att.fileId, attempt]);
  // Attachments sent before the key made it into the envelope can never be opened by anyone but the
  // sender, so don't offer a retry that is certain to fail.
  const permanent = !att.key || !att.iv;
  // Otherwise a download can fail just because the network blinked — let a tap try again.
  return { url, failed, permanent, onRetry: () => setAttempt(n => n + 1) };
}

export function ImageContent({ att, url, failed, permanent, onOpen, onRetry }: Gone & { att: AttachmentPayload; url: string | null; onOpen(): void }) {
  const ratio = att.width && att.height ? att.width / att.height : 4 / 3;
  return <button className="img-frame" style={{ aspectRatio: `${ratio}` }} onClick={() => url ? onOpen() : failed && !permanent && onRetry()} aria-label={att.name}>
    {url
      ? <img src={url} alt={att.name} />
      : failed
        ? <span className="img-gone">🌫️<small>Couldn’t load — {goneNote(permanent)}</small></span>
        : <>{att.thumb && <img className="img-thumb" src={att.thumb} alt="" />}<span className="img-spinner" /></>}
  </button>;
}

export function VideoContent({ att, url, failed, permanent, onRetry }: Gone & { att: AttachmentPayload; url: string | null }) {
  const ratio = att.width && att.height ? att.width / att.height : 16 / 9;
  if (failed) return <button className="img-frame img-gone" style={{ aspectRatio: `${ratio}` }} onClick={() => !permanent && onRetry()}>🌫️<small>Couldn’t load — {goneNote(permanent)}</small></button>;
  if (!url) return <span className="img-frame" style={{ aspectRatio: `${ratio}` }}><span className="img-spinner" /></span>;
  return <video className="video-frame" src={url} controls playsInline preload="metadata" />;
}

export function VoiceContent({ att, url, failed, permanent, onRetry }: Gone & { att: AttachmentPayload; url: string | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const toggle = (): void => {
    if (!url) return;
    if (!audioRef.current) {
      const a = new Audio(url);
      a.onended = () => { setPlaying(false); setProgress(0); };
      a.ontimeupdate = () => {
        const total = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (att.durationMs ?? 1000) / 1000;
        setProgress(Math.min(1, a.currentTime / total));
      };
      audioRef.current = a;
    }
    if (playing) { audioRef.current.pause(); setPlaying(false); }
    else { void audioRef.current.play(); setPlaying(true); }
  };

  if (failed) return <button className="voice gone" onClick={() => !permanent && onRetry()}>🌫️ Couldn’t load — {goneNote(permanent)}</button>;
  return <span className="voice">
    <button className="voice-btn" onClick={toggle} disabled={!url} aria-label={playing ? "Pause" : "Play"}>{!url ? "…" : playing ? "❚❚" : "▶"}</button>
    <span className="voice-track"><i style={{ width: `${progress * 100}%` }} /></span>
    <small>{fmtDuration(att.durationMs ?? 0)}</small>
  </span>;
}

export function FileContent({ att, url, failed, permanent, onOpen, onRetry }: Gone & { att: AttachmentPayload; url: string | null; onOpen(): void }) {
  return <button className="file" onClick={() => failed && !url ? !permanent && onRetry() : onOpen()}>
    <b>{failed ? "🌫️" : "📄"}</b>
    <span><strong>{att.name}</strong><small>{failed ? `Couldn’t load — ${goneNote(permanent)}` : fmtSize(att.size)}</small></span>
  </button>;
}

export function Lightbox({ att, url, onClose }: { att: AttachmentPayload; url: string; onClose(): void }) {
  const [canShare] = useState(() => {
    const nav = navigator as Navigator & { canShare?(data: ShareData): boolean };
    return !!nav.canShare?.({ files: [new File([], att.name || "photo.png", { type: att.mime })] });
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={att.name || "Photo"} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    {mediaKind(att) === "video" ? <video src={url} controls autoPlay playsInline /> : <img src={url} alt={att.name} />}
    <div className="lightbox-bar">
      {canShare && <button className="chip-btn" onClick={() => void shareFile(att.fileId, att.name)}>Share</button>}
      <button className="chip-btn" onClick={() => void saveToDevice(att.fileId, att.name)}>Save</button>
      <button className="chip-btn" onClick={onClose}>Close</button>
    </div>
  </div>;
}
