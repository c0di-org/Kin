import type { Conversation, PublicMember } from "../lib/types";
import { initials, personColour, seedEmoji } from "../lib/format";

/** A person, as a coloured circle holding either their chosen animal or their initials. */
export function Avatar({ member, size = 44 }: { member: PublicMember; size?: number }) {
  const emoji = seedEmoji(member.avatarSeed);
  // Keyed on the device, not the animal: two people who both picked the fox still read apart.
  return <span className="avatar" style={{ width: size, height: size, fontSize: emoji ? size * 0.56 : size * 0.36, background: personColour(member.deviceId).bg }}>
    {emoji ?? initials(member.displayName)}
  </span>;
}

/** The three-dot "someone is typing" mark. */
export function Mark() { return <span className="mark"><i/><i/><i/></span>; }

/** A conversation, as the faces in it: one peer for a direct chat, a stack for a family. */
export function ConversationAvatar({ c, self, small = false }: { c: Conversation; self: string; small?: boolean }) {
  const peer = c.members.find(m => m.deviceId !== self) ?? c.members[0];
  if (c.kind === "direct") return peer ? <Avatar member={peer} size={small ? 38 : 52}/> : <span className="avatar"/>;
  const people = c.members.filter(m => m.deviceId !== self).slice(0, 3);
  if (!people.length && c.members[0]) people.push(c.members[0]);
  return <span className={`stack ${small ? "small" : ""}`}>{people.map(p => <Avatar key={p.deviceId} member={p} size={small ? 27 : 34}/>)}</span>;
}

