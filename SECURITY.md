# Security

Kin encrypts message and attachment contents in the client before they reach Cloudflare. Conversation keys stay on paired devices. The Worker stores and forwards ciphertext; it can still see routing metadata such as room IDs/titles, member display names, public device keys, timestamps, sizes, and push subscriptions.

This v1 protocol uses long-lived P-256 device keys and AES-GCM conversation keys. It provides end-to-end confidentiality and signed message authenticity, but **does not yet provide Signal-style forward secrecy or post-compromise security**.

A conversation can be marked **kept**, which turns off expiry for it entirely: its messages and attachments stay until somebody deletes them, and a kept room is capped at 2 GB and 20,000 messages instead. This is the only way to keep an album readable to somebody who arrives a month later, and it is a deliberate weakening of the promise below — a kept room's ciphertext sits on the relay indefinitely. Rooms are not kept unless you say so when you make one, and the chat details say which kind you are in.

Relay message envelopes and R2 attachments in an ordinary room both expire seven days after the relay stores them: each conversation's Durable Object sweeps its own envelopes and deletes the matching attachments from R2 on the same alarm. Signed requests to the relay commit to a hash of their body and carry a single-use nonce, so a captured request cannot be replayed or have its payload swapped.

A member's device keys are fixed once the relay has recorded them. A **full member** may introduce a new member — that is what pairing does — but only the owner of a member card can change it, and never its keys. Clients enforce the same rule independently and will refuse a key change even if the relay sends one, showing a warning in the family panel instead; compare the safety code in person when you see it.

A card also outlives the roster row that pointed at it. The roster is ordinary relay metadata and nobody signs it, so a client that dropped somebody's key the moment the relay stopped listing them would let the relay make everything that person ever said fail verification and quietly disappear from a thread already on the device. Departed members stay on the device, unlisted, so history keeps checking out.

Local browser storage persists until the user clears site/app data, so attachments you have already opened stay on your device after the relay's copy expires.

## The safety code

Pairing shows two rows of eight pictures, and **both devices work their own out from the keys they actually received**. That is the whole of the check: an earlier version had the inviter compute the code and send it through the relay for the joiner to display, which meant the two phones agreed no matter who had rewritten the keys in between — a relay in the middle could compute the honest pictures from the public cards it already held and show those. Compare the rows in person when you add someone; if they differ, stop and set it up again.

Each row is a forty-bit fingerprint of one device's public key. Laying the two fingerprints side by side rather than hashing the pair together is deliberate: against a single hash of both keys, somebody in the middle only needs `H(alice, mine)` to equal `H(mine', bob)` — two values they choose themselves, so a collision search at half the bits. Against side-by-side fingerprints they have to land on Bob's exact row and then on Alice's, which is two preimages at the full forty bits each.

## Invite links

A standing invite wraps the conversation key under a key derived from a random 256-bit secret, and hands the relay only the ciphertext. The secret travels in the URL fragment, which browsers do not send to servers, so the relay stores something it cannot open. The invite is filed under a code that is a hash of that secret, and redemption must also present a second, differently-derived hash of it — otherwise knowing a code, which the relay knows for every invite it holds, would be enough to join the room behind it.

**An invite link is a capability.** Anyone holding it can walk in, and Kin cannot tell whether the person who opened it is the person you sent it to. What limits the damage is what you choose when you make one: how many people it admits (one by default), and how long it works (a week by default). Any full member of the room can revoke a link, and a revoked or expired link stops working for everyone who has not already used it.

Roles are enforced at the relay, not only in the interface, and on every route that could be used to get round them:

- A **guest** cannot mint invites, cannot enrol a device directly, and cannot evict anybody else — a link you shared with one person cannot become a link they shared with ten, by any of those three routes. They can still leave, which is nobody's to withhold.
- A **viewer** cannot post and cannot upload. The relay refuses their envelopes outright, because it cannot read a payload to tell a message from a reaction; refusing their uploads too is what stops read-only access costing somebody else an album's worth of storage.

Neither role changes what the relay can see, and neither is a substitute for trusting the person.

## Channels

A channel's key is derived with HKDF from the key of the space it belongs to, so every member of a space can compute the key of every channel in it — including channels created after they joined, and channels they have never opened. **Channels partition attention, not access.** Anything that needs a narrower audience than the space needs to be a separate group with its own key, not a channel.

Removal is still a relay-side eviction rather than a key rotation: a device that has been removed, or a guest whose link was revoked after they used it, keeps whatever key it already holds and whatever it already received. Rotating a conversation key on removal is the next thing this protocol needs, and it does not have it yet.

What eviction does do is take effect immediately. Removing a device closes its live WebSocket as well as deleting its roster row — a hibernating socket outlives the request that removed the member holding it, so an eviction that only touched storage left the removed phone receiving every message sent afterwards, which is exactly the lost-or-handed-on device the feature exists for.

## Deleting

Deleting a message for everyone posts a signed tombstone that every client folds in and acts on, **and** asks the relay to drop the ciphertext and any attachment behind it. In an ordinary room that only brings forward an expiry that was coming inside the week anyway. In a kept room there is no expiry at all, so it is the only thing that makes a deletion real there — and the only way an album that has reached its 2 GB ceiling can be given room again. The relay accepts a message deletion from its sender only, matching the rule clients already apply, because it cannot read a payload and so cannot tell a retraction from somebody else's censorship.

When the last member of a room leaves, the room closes: its history, its attachments and its sockets all go. Refusing that — which is what an earlier version did — stranded any group that had been made and never shared.
