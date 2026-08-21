import type { ChatMessage, Conversation, LocalIdentity } from "./types";

const DB_NAME = "kin-v1";
const VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("conversations")) db.createObjectStore("conversations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: "id" });
        store.createIndex("conversation", ["conversationId", "createdAt"]);
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "fileId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export type StoredBlob = { fileId: string; mime: string; name: string; bytes: ArrayBuffer; createdAt: number };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getIdentity(): Promise<LocalIdentity | null> {
  const db = await openDb();
  const tx = db.transaction("meta", "readonly");
  return (await request(tx.objectStore("meta").get("identity"))) ?? null;
}
export async function putIdentity(identity: LocalIdentity): Promise<void> {
  const db = await openDb(); const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put(identity, "identity");
}
export async function listConversations(): Promise<Conversation[]> {
  const db = await openDb(); const tx = db.transaction("conversations", "readonly");
  const all = await request(tx.objectStore("conversations").getAll()) as Conversation[];
  return all.sort((a,b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}
export async function putConversation(conversation: Conversation): Promise<void> {
  const db = await openDb(); const tx = db.transaction("conversations", "readwrite"); tx.objectStore("conversations").put(conversation);
}
export async function putMessage(message: ChatMessage): Promise<void> {
  const db = await openDb(); const tx = db.transaction("messages", "readwrite"); tx.objectStore("messages").put(message);
}
export async function listMessages(conversationId: string, limit = 400): Promise<ChatMessage[]> {
  const db = await openDb(); const tx = db.transaction("messages", "readonly");
  const idx = tx.objectStore("messages").index("conversation");
  const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]);
  const rows = await request(idx.getAll(range)) as ChatMessage[];
  return rows.slice(-limit);
}
export async function getMessage(id: string): Promise<ChatMessage | null> {
  const db = await openDb(); const tx = db.transaction("messages", "readonly");
  return (await request(tx.objectStore("messages").get(id))) ?? null;
}
export async function deleteMessage(id: string): Promise<void> {
  const db = await openDb(); const tx = db.transaction("messages", "readwrite"); tx.objectStore("messages").delete(id);
}
export async function putBlob(record: StoredBlob): Promise<void> {
  const db = await openDb(); const tx = db.transaction("blobs", "readwrite"); tx.objectStore("blobs").put(record);
}
export async function getBlob(fileId: string): Promise<StoredBlob | null> {
  const db = await openDb(); const tx = db.transaction("blobs", "readonly");
  return (await request(tx.objectStore("blobs").get(fileId))) ?? null;
}
export async function clearAll(): Promise<void> {
  indexedDB.deleteDatabase(DB_NAME);
}
