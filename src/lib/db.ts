import type { ChatMessage, Conversation, LocalIdentity } from "./types";

const DB_NAME = "kin-v1";
const VERSION = 2;

function open(): Promise<IDBDatabase> {
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

let connection: Promise<IDBDatabase> | null = null;

/**
 * One connection, reused. Opening the database costs about as much as the query it is being
 * opened for, so reopening it per call made the boot path — which runs hundreds of calls —
 * spend nearly all of its time in indexedDB.open. Dropped if the connection ever closes under
 * us, so the next caller reopens rather than failing forever.
 */
function db(): Promise<IDBDatabase> {
  if (!connection) {
    connection = open().then(conn => {
      conn.onclose = () => { connection = null; };
      conn.onversionchange = () => { conn.close(); connection = null; };
      return conn;
    });
    connection.catch(() => { connection = null; });
  }
  return connection;
}

export type StoredBlob = { fileId: string; mime: string; name: string; bytes: ArrayBuffer; createdAt: number };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve once the writes are actually durable, rather than once they have been queued. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function read<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await db();
  return request(fn(conn.transaction(store, "readonly").objectStore(store)));
}

async function write(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  const conn = await db();
  const tx = conn.transaction(store, "readwrite");
  fn(tx.objectStore(store));
  return committed(tx);
}

/**
 * Small standing preferences — which conversation to open into, and whatever follows it.
 *
 * They share the `meta` store with the identity rather than getting one of their own, so adding
 * one never costs a schema version. Anything stored here has to survive not being there: a device
 * that has never set it reads null and the caller decides what that means.
 */
export async function getSetting<T>(key: string): Promise<T | null> {
  return (await read<T>("meta", s => s.get(`setting:${key}`))) ?? null;
}
export async function putSetting<T>(key: string, value: T): Promise<void> {
  return write("meta", s => { s.put(value, `setting:${key}`); });
}

export async function getIdentity(): Promise<LocalIdentity | null> {
  return (await read<LocalIdentity>("meta", s => s.get("identity"))) ?? null;
}
export async function putIdentity(identity: LocalIdentity): Promise<void> {
  return write("meta", s => { s.put(identity, "identity"); });
}
export async function listConversations(): Promise<Conversation[]> {
  const all = await read<Conversation[]>("conversations", s => s.getAll());
  return all.sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}
export async function putConversation(conversation: Conversation): Promise<void> {
  return write("conversations", s => { s.put(conversation); });
}
export async function putMessage(message: ChatMessage): Promise<void> {
  return write("messages", s => { s.put(message); });
}
/** One transaction for a whole batch — a history replay lands hundreds of messages at once. */
export async function putMessages(messages: ChatMessage[]): Promise<void> {
  if (!messages.length) return;
  return write("messages", s => { for (const m of messages) s.put(m); });
}
export async function getMessage(id: string): Promise<ChatMessage | null> {
  return (await read<ChatMessage>("messages", s => s.get(id))) ?? null;
}
/** Which of these ids we already hold, in a single transaction, for deduplicating a history pull. */
export async function knownMessageIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const conn = await db();
  const store = conn.transaction("messages", "readonly").objectStore("messages");
  const found = new Set<string>();
  await Promise.all(ids.map(id => request(store.getKey(id)).then(key => { if (key !== undefined) found.add(id); })));
  return found;
}

function conversationRange(conversationId: string, until = Number.MAX_SAFE_INTEGER): IDBKeyRange {
  return IDBKeyRange.bound([conversationId, 0], [conversationId, until]);
}

/**
 * The newest `limit` messages, oldest-first. Walks backwards from the end and stops, rather than
 * materialising an entire conversation to keep its tail — which on a deep archive read every
 * message ever exchanged just to render one screen.
 */
export async function listMessages(conversationId: string, limit = 400): Promise<ChatMessage[]> {
  const conn = await db();
  const index = conn.transaction("messages", "readonly").objectStore("messages").index("conversation");
  const req = index.openCursor(conversationRange(conversationId), "prev");
  const rows: ChatMessage[] = [];
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || rows.length >= limit) return resolve(rows.reverse());
      rows.push(cursor.value as ChatMessage);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mark our own messages up to `until` as read, and return the ones that changed.
 *
 * Read receipts only move forward, so the first of ours already marked read means everything
 * older is too — which turns a rewrite of the whole conversation, on every single receipt, into
 * a walk over what actually changed.
 */
export async function markOwnMessagesRead(conversationId: string, deviceId: string, until: number): Promise<ChatMessage[]> {
  const conn = await db();
  const tx = conn.transaction("messages", "readwrite");
  const req = tx.objectStore("messages").index("conversation").openCursor(conversationRange(conversationId, until), "prev");
  const updated: ChatMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const message = cursor.value as ChatMessage;
      if (message.senderDeviceId === deviceId) {
        if (message.status === "read") return resolve();
        const next = { ...message, status: "read" as const };
        cursor.update(next);
        updated.push(next);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await committed(tx);
  return updated;
}

/**
 * Forget a conversation completely: its row, its messages, and the attachment bytes only it was
 * holding. Leaving the blobs behind would keep the photos from a chat the user just deleted
 * sitting on the device indefinitely, which is not what deleting a chat means.
 */
/**
 * Direct chats we have deleted, and when.
 *
 * A direct room id is derived from the two device keys, so the discovery sweep finds it again
 * within thirty seconds of it being deleted and pulls the whole history back. The timestamp is
 * what keeps "delete" and "they can always message me again" from contradicting each other:
 * anything older than it stays gone, anything newer brings the chat back.
 */
export async function dismissedDirects(): Promise<Record<string, number>> {
  return (await read<Record<string, number>>("meta", s => s.get("dismissedDirects"))) ?? {};
}
export async function dismissDirect(conversationId: string, at = Date.now()): Promise<void> {
  const current = await dismissedDirects();
  return write("meta", s => { s.put({ ...current, [conversationId]: at }, "dismissedDirects"); });
}
export async function undismissDirect(conversationId: string): Promise<void> {
  const { [conversationId]: _gone, ...rest } = await dismissedDirects();
  return write("meta", s => { s.put(rest, "dismissedDirects"); });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const messages = await listMessages(conversationId, Number.MAX_SAFE_INTEGER);
  const fileIds = messages.flatMap(m => m.payload.attachment ? [m.payload.attachment.fileId] : []);
  const conn = await db();
  const tx = conn.transaction(["conversations", "messages", "blobs"], "readwrite");
  tx.objectStore("conversations").delete(conversationId);
  for (const m of messages) tx.objectStore("messages").delete(m.id);
  for (const id of fileIds) tx.objectStore("blobs").delete(id);
  return committed(tx);
}

export async function deleteMessage(id: string): Promise<void> {
  return write("messages", s => { s.delete(id); });
}
export async function putBlob(record: StoredBlob): Promise<void> {
  return write("blobs", s => { s.put(record); });
}
export async function getBlob(fileId: string): Promise<StoredBlob | null> {
  return (await read<StoredBlob>("blobs", s => s.get(fileId))) ?? null;
}
