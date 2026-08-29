import type { Conversation, PublicMember } from "../lib/types";
import { initials, personColour, seedEmoji } from "../lib/format";
import { NOTES_EMOJI } from "../lib/notes";

/** A person, as a coloured circle holding either their chosen animal or their initials. */
export function Avatar({ member, size = 44 }: { member: PublicMember; size?: number }) {
  const emoji = seedEmoji(member.avatarSeed);
  // Keyed on the device, not the animal: two people who both picked the fox still read apart.
  // The circle keeps the animal inside it by way of `line-height: normal` on `.avatar` — see the
  // note there; the ratio below is only how big it is, not whether it fits.
  return <span className="avatar" style={{ width: size, height: size, fontSize: emoji ? size * 0.56 : size * 0.36, background: personColour(member.deviceId).bg }}>
    {emoji ?? initials(member.displayName)}
  </span>;
}

/** The three-dot "someone is typing" mark. */
export function Mark() { return <span className="mark"><i/><i/><i/></span>; }

/** A conversation, as the faces in it: one peer for a direct chat, a stack for a family. */
export function ConversationAvatar({ c, self, small = false }: { c: Conversation; self: string; small?: boolean }) {
  // Your own room draws as the thing it is for, rather than as your own face. A stack of one
  // showing you back to yourself reads as a group you are the last one left in.
  if (c.self) return <span className={`avatar notes-face ${small ? "small" : ""}`} aria-hidden>{NOTES_EMOJI}</span>;
  const peer = c.members.find(m => m.deviceId !== self) ?? c.members[0];
  if (c.kind === "direct") return peer ? <Avatar member={peer} size={small ? 38 : 52}/> : <span className="avatar"/>;
  const people = c.members.filter(m => m.deviceId !== self).slice(0, 3);
  if (!people.length && c.members[0]) people.push(c.members[0]);
  return <span className={`stack ${small ? "small" : ""}`}>{people.map(p => <Avatar key={p.deviceId} member={p} size={small ? 27 : 34}/>)}</span>;
}

