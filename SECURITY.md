# Security

Kin encrypts message and attachment contents in the client before they reach Cloudflare. Conversation keys stay on paired devices. The Worker stores and forwards ciphertext; it can still see routing metadata such as room IDs/titles, member display names, public device keys, timestamps, sizes, and push subscriptions.

This v1 protocol uses long-lived P-256 device keys and AES-GCM conversation keys. It provides end-to-end confidentiality and signed message authenticity, but **does not yet provide Signal-style forward secrecy or post-compromise security**. Pairing displays a four-emoji safety code; compare it on both devices when adding someone.

A conversation can be marked **kept**, which turns off expiry for it entirely: its messages and attachments stay until somebody deletes them, and a kept room is capped at 2 GB and 20,000 messages instead. This is the only way to keep an album readable to somebody who arrives a month later, and it is a deliberate weakening of the promise below — a kept room's ciphertext sits on the relay indefinitely. Rooms are not kept unless you say so when you make one, and the chat details say which kind you are in.

Relay message envelopes and R2 attachments in an ordinary room both expire seven days after the relay stores them: each conversation's Durable Object sweeps its own envelopes and deletes the matching attachments from R2 on the same alarm. Signed requests to the relay commit to a hash of their body and carry a single-use nonce, so a captured request cannot be replayed or have its payload swapped.

A member's device keys are fixed once the relay has recorded them. Anyone in a room may introduce a new member — that is how an invite adds someone — but only the owner of a member card can change it, and never its keys. Clients enforce the same rule independently and will refuse a key change even if the relay sends one, showing a warning in the family panel instead; compare the safety code in person when you see it.

Local browser storage persists until the user clears site/app data, so attachments you have already opened stay on your device after the relay's copy expires.

## Invite links

A standing invite wraps the conversation key under a key derived from a random 256-bit secret, and hands the relay only the ciphertext. The secret travels in the URL fragment, which browsers do not send to servers, so the relay stores something it cannot open. The invite is filed under a code that is a hash of that secret, and redemption must also present a second, differently-derived hash of it — otherwise knowing a code, which the relay knows for every invite it holds, would be enough to join the room behind it.

**An invite link is a capability.** Anyone holding it can walk in, and Kin cannot tell whether the person who opened it is the person you sent it to. What limits the damage is what you choose when you make one: how many people it admits (one by default), and how long it works (a week by default). Any full member of the room can revoke a link, and a revoked or expired link stops working for everyone who has not already used it.

Roles are enforced at the relay, not only in the interface. A **guest** cannot mint invites, so a link you shared with one person cannot become a link they shared with ten. A **viewer** cannot post: the relay refuses their envelopes outright, because it cannot read a payload to tell a message from a reaction. Neither role changes what the relay can see, and neither is a substitute for trusting the person.

## Channels

A channel's key is derived with HKDF from the key of the space it belongs to, so every member of a space can compute the key of every channel in it — including channels created after they joined, and channels they have never opened. **Channels partition attention, not access.** Anything that needs a narrower audience than the space needs to be a separate group with its own key, not a channel.

Removal is still a relay-side eviction rather than a key rotation: a device that has been removed, or a guest whose link was revoked after they used it, keeps whatever key it already holds and whatever it already received. Rotating a conversation key on removal is the next thing this protocol needs, and it does not have it yet.
