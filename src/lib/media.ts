import type { AttachmentPayload, Conversation, LocalIdentity } from "./types";
import { decryptFile, sha256 } from "./crypto";
import { downloadEncryptedFile } from "./relay";
import { getBlob, putBlob } from "./db";

export type MediaKind = "image" | "video" | "audio" | "file";

export function mediaKind(att: AttachmentPayload): MediaKind {
  if (att.mime.startsWith("image/")) return "image";
  if (att.mime.startsWith("video/")) return "video";
  if (att.mime.startsWith("audio/")) return "audio";
  return "file";
}

export function isDoodle(att: AttachmentPayload): boolean {
  return att.name.startsWith("doodle-") && att.mime === "image/png";
}

export function previewLabel(att: AttachmentPayload): string {
  if (isDoodle(att)) return "🖍️ Doodle";
  const kind = mediaKind(att);
  if (kind === "image") return "📷 Photo";
  if (kind === "video") return "🎬 Video";
  if (kind === "audio") return "🎤 Voice note";
  return `📎 ${att.name}`;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Measure an image and produce a tiny blurred inline preview that rides along inside the encrypted payload. */
export async function probeImage(file: Blob): Promise<{ width: number; height: number; thumb?: string } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    let thumb: string | undefined;
    try {
      const max = 32;
      const scale = Math.min(1, max / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      thumb = canvas.toDataURL("image/jpeg", 0.5);
      if (thumb.length > 4096) thumb = undefined;
    } catch { /* preview is optional */ }
    bitmap.close();
    return { width, height, thumb };
  } catch { return null; }
}

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export function cachedUrl(fileId: string): string | null {
  return urls.get(fileId) ?? null;
}

/** Resolve an attachment to an object URL: memory → IndexedDB → relay download (then cached locally forever). */
export function resolveAttachment(identity: LocalIdentity, conversation: Conversation, att: AttachmentPayload): Promise<string | null> {
  const hit = urls.get(att.fileId);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(att.fileId);
  if (inflight) return inflight;
  const job = (async () => {
    try {
      let stored = await getBlob(att.fileId);
      if (!stored) {
        const cipher = await downloadEncryptedFile(identity, conversation.id, att.fileId);
        // The digest travels inside the encrypted payload, so only the conversation can check it.
        // AES-GCM would catch altered bytes anyway, but as an indistinguishable "cannot decrypt";
        // checking first tells a truncated download apart from a key we do not hold.
        if (att.sha256 && (await sha256(cipher)) !== att.sha256) {
          throw new Error(`attachment ${att.fileId} failed its checksum — the download is corrupt`);
        }
        const clear = await decryptFile(cipher, att.key, att.iv);
        stored = { fileId: att.fileId, mime: att.mime, name: att.name, bytes: clear, createdAt: Date.now() };
        await putBlob(stored);
      }
      const url = URL.createObjectURL(new Blob([stored.bytes], { type: stored.mime }));
      urls.set(att.fileId, url);
      return url;
    } catch (err) {
      console.error("kin-attachment-failed", att.fileId, err);
      return null;
    } finally { pending.delete(att.fileId); }
  })();
  pending.set(att.fileId, job);
  return job;
}

/** Remember a freshly-sent file locally so our own media renders instantly and outlives the relay. */
export async function rememberLocalFile(fileId: string, file: Blob, name: string, mime: string): Promise<string> {
  const bytes = await file.arrayBuffer();
  await putBlob({ fileId, mime, name, bytes, createdAt: Date.now() });
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  urls.set(fileId, url);
  return url;
}

export async function saveToDevice(fileId: string, fallbackName: string): Promise<void> {
  const stored = await getBlob(fileId);
  if (!stored) throw new Error("missing");
  const url = URL.createObjectURL(new Blob([stored.bytes], { type: stored.mime }));
  const link = document.createElement("a");
  link.href = url; link.download = stored.name || fallbackName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function shareFile(fileId: string, fallbackName: string): Promise<boolean> {
  const stored = await getBlob(fileId);
  if (!stored) return false;
  const file = new File([stored.bytes], stored.name || fallbackName, { type: stored.mime });
  const nav = navigator as Navigator & { canShare?(data: ShareData): boolean };
  if (nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch { return false; }
  }
  return false;
}
