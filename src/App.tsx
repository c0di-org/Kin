import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { decryptFile, decryptPayload, directConversation, encryptFile, encryptPayload, generateIdentity, publicMember, randomId, randomKey, safetyCode, signEnvelope, unwrapConversationKey, verifyEnvelope, wrapConversationKey } from "./lib/crypto";
import { getIdentity, listConversations, listMessages, putConversation, putIdentity, putMessage } from "./lib/db";
import { addRoomMember, claimPair, completePair, createPair, createRoom, downloadEncryptedFile, history, joinPair, pairStatus, registerPush, relayConfig, roomMembers, sendEnvelope, uploadEncryptedFile, websocketUrl } from "./lib/relay";
import type { ChatMessage, ChatPayload, CipherEnvelope, Conversation, LocalIdentity, PublicMember } from "./lib/types";

type Panel = "none" | "pair" | "join" | "members" | "settings";
type InstallPrompt = Event & { prompt(): Promise<void> };
const MAX_FILE = 25 * 1024 * 1024;

const initials = (s: string) => s.trim().split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join("") || "•";
const hue = (s: string) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 360;
const time = (n: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(n);

function Avatar({ member, size = 40 }: { member: PublicMember; size?: number }) {
  return <span className="avatar" style={{ width: size, height: size, background: `hsl(${hue(member.avatarSeed)} 55% 72%)` }}>{initials(member.displayName)}</span>;
}

function Mark() { return <span className="mark"><i/><i/><i/></span>; }

export default function App() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(new URLSearchParams(location.search).get("conversation"));
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [pair, setPair] = useState<{ code: string; token: string; qr?: string; safety?: string } | null>(null);
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get("pair") ?? "");
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [toast, setToast] = useState("");
  const [typing, setTyping] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const active = conversations.find(c => c.id === activeId) ?? null;
  const activeMessages = messages[activeId ?? ""] ?? [];

  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(""), 2200); };
  async function refresh() { setConversations(await listConversations()); }

  useEffect(() => {
    (async () => {
      const id = await getIdentity();
      setIdentity(id);
      const cs = await listConversations();
      setConversations(cs);
      if (!activeId && innerWidth > 760) setActiveId(cs[0]?.id ?? null);
      if (id && joinCode) setPanel("join");
      setReady(true);
    })();
    const onInstall = (e: Event) => { e.preventDefault(); setInstallPrompt(e as InstallPrompt); };
    addEventListener("beforeinstallprompt", onInstall);
    return () => removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    if (!identity || !active) return;
    let dead = false;
    ws.current?.close();
    (async () => {
      setMessages(x => ({ ...x, [active.id]: await listMessages(active.id) }));
      try { for (const e of await history(identity, active.id)) await ingest(active, e); } catch {}
      if (active.kind === "group") {
        try {
          const members = await roomMembers(identity, active.id);
          await putConversation({ ...active, members });
          await refresh();
        } catch {}
      }
      try {
        const socket = new WebSocket(await websocketUrl(identity, active.id));
        socket.onmessage = async ev => {
          const f = JSON.parse(String(ev.data));
          if (f.kind === "message") await ingest(active, f);
          if (f.kind === "member" && f.member) {
            const current = (await listConversations()).find(c => c.id === active.id) ?? active;
            await putConversation({ ...current, members: [...current.members.filter(m => m.deviceId !== f.member.deviceId), f.member] });
            await refresh();
          }
          if (f.kind === "typing" && f.senderDeviceId !== identity.deviceId) setTyping(t => f.active ? [...new Set([...t, f.senderDeviceId])] : t.filter(x => x !== f.senderDeviceId));
        };
        if (!dead) ws.current = socket; else socket.close();
      } catch {}
    })();
    return () => { dead = true; ws.current?.close(); ws.current = null; setTyping([]); };
  }, [identity?.deviceId, activeId]);

  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [activeMessages.length, typing.length]);

  async function ingest(conversation: Conversation, env: CipherEnvelope) {
    const current = (await listConversations()).find(c => c.id === conversation.id) ?? conversation;
    const sender = current.members.find(m => m.deviceId === env.senderDeviceId);
    if (!sender || !(await verifyEnvelope(env, sender))) return;
    try {
      const payload = await decryptPayload(env, current.key);
      const m: ChatMessage = { id: env.id, conversationId: current.id, senderDeviceId: env.senderDeviceId, createdAt: env.createdAt, payload, status: "delivered" };
      await putMessage(m);
      setMessages(x => ({ ...x, [current.id]: [...(x[current.id] ?? []).filter(y => y.id !== m.id), m].sort((a,b) => a.createdAt - b.createdAt) }));
      await putConversation({ ...current, lastMessageAt: m.createdAt, lastPreview: payload.type === "text" ? payload.text : payload.type === "file" ? "Attachment" : "" });
      await refresh();
    } catch {}
  }

  async function send(payload: ChatPayload) {
    if (!identity || !active) return;
    const env = await signEnvelope(identity, await encryptPayload(active.id, active.key, identity.deviceId, payload));
    const optimistic: ChatMessage = { id: env.id, conversationId: active.id, senderDeviceId: identity.deviceId, createdAt: env.createdAt, payload, status: "sending" };
    await putMessage(optimistic);
    setMessages(x => ({ ...x, [active.id]: [...(x[active.id] ?? []), optimistic] }));
    try {
      await sendEnvelope(active.id, env);
      await putMessage({ ...optimistic, status: "sent" });
      setMessages(x => ({ ...x, [active.id]: (x[active.id] ?? []).map(m => m.id === env.id ? { ...m, status: "sent" } : m) }));
      await putConversation({ ...active, lastMessageAt: env.createdAt, lastPreview: payload.type === "text" ? payload.text : "Attachment" });
      await refresh();
    } catch { flash("Couldn’t send"); }
  }

  async function sendText() {
    const text = draft.trim(); if (!text) return;
    setDraft(""); ws.current?.send(JSON.stringify({ kind: "typing", active: false }));
    await send({ type: "text", text });
  }

  async function sendFile(file: File) {
    if (!identity || !active) return;
    if (file.size > MAX_FILE) return flash("25 MB max");
    try {
      const encrypted = await encryptFile(file); const fileId = randomId();
      await uploadEncryptedFile(identity, active.id, fileId, encrypted.ciphertext, encrypted.sha256);
      await send({ type: "file", attachment: { fileId, name: file.name, mime: file.type || "application/octet-stream", size: file.size, iv: encrypted.iv, key: encrypted.key, sha256: encrypted.sha256 } });
    } catch { flash("Upload failed"); }
  }

  async function openFile(m: ChatMessage) {
    const a = m.payload.attachment; if (!identity || !active || !a) return;
    try {
      const cipher = await downloadEncryptedFile(identity, active.id, a.fileId);
      const clear = await decryptFile(cipher, a.key, a.iv);
      const url = URL.createObjectURL(new Blob([clear], { type: a.mime }));
      const link = document.createElement("a"); link.href = url; link.download = a.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { flash("File expired"); }
  }

  async function createFamily(name: string) {
    const id = await generateIdentity(name); const group: Conversation = { id: randomId(), kind: "group", title: "Family", key: randomKey(), members: [publicMember(id)], createdAt: Date.now() };
    await putIdentity(id); await putConversation(group); await createRoom(group.id, "group", group.title, group.members);
    setIdentity(id); await refresh(); setActiveId(group.id);
  }

  async function joinFamily(name?: string, rawCode?: string) {
    let id = identity;
    if (!id) { id = await generateIdentity(name ?? "Family"); await putIdentity(id); setIdentity(id); }
    const code = (rawCode ?? joinCode).trim().toUpperCase(); if (!code) return;
    const { claimToken } = await joinPair(code, publicMember(id));
    flash("Waiting for approval…");
    for (let i=0;i<60;i++) {
      try {
        const pkg = await claimPair(code, claimToken);
        const key = await unwrapConversationKey(id, pkg.creator, pkg.group.wrappedKey, pkg.group.wrapIv);
        let members = [pkg.creator, publicMember(id)];
        try { members = await roomMembers(id, pkg.group.id); } catch {}
        const c: Conversation = { id: pkg.group.id, kind: "group", title: pkg.group.title, key, members, createdAt: Date.now() };
        await putConversation(c); await refresh(); setActiveId(c.id); setPanel("none"); flash(`Paired ${pkg.safetyCode}`); history.replaceState({}, "", "/"); return;
      } catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    flash("Pairing timed out");
  }

  async function startPairing() {
    if (!identity || !active || active.kind !== "group") return;
    setPanel("pair");
    const p = await createPair(publicMember(identity), { id: active.id, title: active.title });
    const link = `${location.origin}${location.pathname}?pair=${encodeURIComponent(p.code)}`;
    setPair({ code: p.code, token: p.creatorToken, qr: await QRCode.toDataURL(link, { margin: 1, width: 220 }) });
    for (let i=0;i<120;i++) {
      if (panel === "none") break;
      try {
        const status = await pairStatus(p.code, p.creatorToken);
        if (status.joiner) {
          const wrap = await wrapConversationKey(identity, status.joiner, active.key);
          await addRoomMember(identity, active.id, status.joiner);
          const code = await safetyCode(publicMember(identity), status.joiner);
          await completePair(p.code, { creator: publicMember(identity), group: { id: active.id, title: active.title, ...wrap }, safetyCode: code }, p.creatorToken);
          const current = (await listConversations()).find(c => c.id === active.id) ?? active;
          await putConversation({ ...current, members: [...current.members.filter(m => m.deviceId !== status.joiner!.deviceId), status.joiner] });
          await refresh(); setPair(x => x ? { ...x, safety: code } : x); return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async function privateChat(peer: PublicMember) {
    if (!identity) return;
    const d = await directConversation(identity, peer);
    const c: Conversation = { id: d.id, kind: "direct", title: peer.displayName, key: d.key, members: [publicMember(identity), peer], createdAt: Date.now() };
    await createRoom(c.id, "direct", c.title, c.members); await putConversation(c); await refresh(); setActiveId(c.id); setPanel("none");
  }

  async function enableNotifications() {
    if (!identity || !active || !("serviceWorker" in navigator) || !("PushManager" in window)) return flash("Not available here");
    try {
      const permission = await Notification.requestPermission(); if (permission !== "granted") return;
      const cfg = await relayConfig(); if (!cfg.vapidPublicKey) return flash("Push not configured");
      const reg = await navigator.serviceWorker.ready;
      const raw = cfg.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/");
      const key = Uint8Array.from(atob(raw + "===".slice((raw.length+3)%4)), c => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await registerPush(identity, active.id, sub); flash("Notifications on");
    } catch { flash("Couldn’t enable notifications"); }
  }

  const sorted = useMemo(() => [...conversations].sort((a,b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)), [conversations]);
  if (!ready) return <div className="splash"><Mark/></div>;
  if (!identity) return <Onboarding pairCode={joinCode} create={createFamily} join={joinFamily}/>;

  return <div className="app">
    <aside className={`sidebar ${active ? "has-active" : ""}`}>
      <header><div className="wordmark"><Mark/><strong>Kin</strong></div><button className="round" onClick={() => setPanel("settings")}>•••</button></header>
      <div className="conversation-list">
        {sorted.map(c => <button key={c.id} className={`conversation ${c.id===activeId?"active":""}`} onClick={() => setActiveId(c.id)}>
          <ConversationAvatar c={c} self={identity.deviceId}/><span><strong>{c.title}</strong><small>{c.lastPreview || (c.kind === "group" ? `${c.members.length} people` : "Private")}</small></span><time>{c.lastMessageAt ? time(c.lastMessageAt) : ""}</time>
        </button>)}
      </div>
      <button className="new-chat" onClick={() => setPanel("join")}>+</button>
    </aside>

    <main className={`chat ${active ? "open" : ""}`}>
      {active ? <>
        <header className="chat-head"><button className="back" onClick={() => setActiveId(null)}>‹</button><button className="chat-person" onClick={() => active.kind === "group" && setPanel("members")}><ConversationAvatar c={active} self={identity.deviceId} small/><span><strong>{active.title}</strong><small>{typing.length ? "typing…" : active.kind === "group" ? `${active.members.length} people` : "private"}</small></span></button><button className="round" onClick={() => active.kind === "group" ? startPairing() : setPanel("settings")}>+</button></header>
        <div className="messages" ref={scroll}>{activeMessages.map((m,i) => <Bubble key={m.id} m={m} prev={activeMessages[i-1]} me={identity.deviceId} c={active} openFile={() => openFile(m)}/>)}{typing.length>0&&<div className="typing"><i/><i/><i/></div>}</div>
        <div className="composer"><input ref={fileInput} type="file" hidden onChange={e => { const f=e.target.files?.[0]; if(f) sendFile(f); e.currentTarget.value=""; }}/><button onClick={() => fileInput.current?.click()}>＋</button><textarea rows={1} placeholder="Message" value={draft} onChange={e => { setDraft(e.target.value); ws.current?.readyState===1&&ws.current.send(JSON.stringify({kind:"typing",active:!!e.target.value})); }} onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendText();}}}/><button className="send" disabled={!draft.trim()} onClick={sendText}>↑</button></div>
      </> : <div className="empty"><Mark/><span>Kin</span></div>}
    </main>

    {panel !== "none" && <div className="scrim" onMouseDown={e => e.target===e.currentTarget&&setPanel("none")}><section className="sheet"><div className="grab"/>
      {panel==="pair"&&pair&&<><h2>Add person</h2>{pair.safety?<div className="paired"><b>✓</b><strong>Paired</strong><div>{pair.safety}</div><small>Compare on both phones</small></div>:<><img className="qr" src={pair.qr}/><div className="code">{pair.code}</div><small>Scan or enter the code</small></>}</>}
      {panel==="join"&&<><h2>Pair</h2><input className="code-input" autoFocus placeholder="Code" value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())}/><button className="primary" onClick={()=>joinFamily(undefined,joinCode)}>Join</button></>}
      {panel==="members"&&active&&<><div className="sheet-title"><h2>{active.title}</h2><button onClick={startPairing}>＋</button></div>{active.members.map(m=><button className="member" key={m.deviceId} disabled={m.deviceId===identity.deviceId} onClick={()=>privateChat(m)}><Avatar member={m}/><span><strong>{m.displayName}{m.deviceId===identity.deviceId?" · you":""}</strong><small>{m.deviceId===identity.deviceId?"This device":"Private chat"}</small></span></button>)}</>}
      {panel==="settings"&&<><div className="profile"><Avatar member={publicMember(identity)} size={56}/><strong>{identity.displayName}</strong></div>{installPrompt&&<button className="setting" onClick={()=>installPrompt.prompt()}>Install app</button>}<button className="setting" onClick={enableNotifications}>Notifications</button><button className="setting" onClick={()=>setPanel("join")}>Join with code</button><small className="privacy">Encrypted relay · 7 day delivery window</small></>}
    </section></div>}
    {toast&&<div className="toast">{toast}</div>}
  </div>;
}

function ConversationAvatar({ c, self, small=false }: { c: Conversation; self:string; small?:boolean }) {
  const peer = c.members.find(m=>m.deviceId!==self) ?? c.members[0];
  if (c.kind==="direct") return peer ? <Avatar member={peer} size={small?34:46}/> : <span className="avatar"/>;
  const people=c.members.filter(m=>m.deviceId!==self).slice(0,3); if(!people.length&&c.members[0]) people.push(c.members[0]);
  return <span className={`stack ${small?"small":""}`}>{people.map(p=><Avatar key={p.deviceId} member={p} size={small?25:31}/>)}</span>;
}

function Bubble({ m, prev, me, c, openFile }: { m:ChatMessage;prev?:ChatMessage;me:string;c:Conversation;openFile():void }) {
  const mine=m.senderDeviceId===me; const sender=c.members.find(x=>x.deviceId===m.senderDeviceId); const show=c.kind==="group"&&!mine&&(!prev||prev.senderDeviceId!==m.senderDeviceId);
  return <div className={`row ${mine?"mine":"theirs"}`}><div className="bubble">{show&&<small className="sender">{sender?.displayName}</small>}{m.payload.type==="text"&&<span>{m.payload.text}</span>}{m.payload.type==="file"&&m.payload.attachment&&<button className="file" onClick={openFile}><b>↧</b><span><strong>{m.payload.attachment.name}</strong><small>{Math.max(1,Math.round(m.payload.attachment.size/1024))} KB</small></span></button>}<small className="stamp">{time(m.createdAt)}{mine&&m.status==="failed"?" !":""}</small></div></div>;
}

function Onboarding({ pairCode, create, join }: { pairCode:string;create(name:string):Promise<void>;join(name:string,code:string):Promise<void> }) {
  const [name,setName]=useState(""); const [code,setCode]=useState(pairCode); const [joining,setJoining]=useState(!!pairCode); const [busy,setBusy]=useState(false);
  const go=async()=>{if(!name.trim())return;setBusy(true);try{joining?await join(name,code):await create(name)}finally{setBusy(false)}};
  return <div className="onboarding"><div className="onboard"><div className="big-brand"><Mark/><strong>Kin</strong></div><input autoFocus placeholder="Your name" value={name} onChange={e=>setName(e.target.value)}/>{joining&&<input placeholder="Pair code" value={code} onChange={e=>setCode(e.target.value.toUpperCase())}/>}<button className="primary" disabled={busy||!name.trim()||(joining&&code.length<6)} onClick={go}>{busy?"…":joining?"Join":"Create family"}</button><button className="link" onClick={()=>setJoining(!joining)}>{joining?"Create a family":"I have a code"}</button></div></div>;
}
