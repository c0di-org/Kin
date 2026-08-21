# Security

Kin encrypts message and attachment contents in the client before they reach Cloudflare. Conversation keys stay on paired devices. The Worker stores and forwards ciphertext; it can still see routing metadata such as room IDs/titles, member display names, public device keys, timestamps, sizes, and push subscriptions.

This v1 protocol uses long-lived P-256 device keys and AES-GCM conversation keys. It provides end-to-end confidentiality and signed message authenticity, but **does not yet provide Signal-style forward secrecy or post-compromise security**. Pairing displays a four-emoji safety code; compare it on both devices when adding someone.

Relay message envelopes and R2 attachments both expire seven days after the relay stores them: each conversation's Durable Object sweeps its own envelopes and deletes the matching attachments from R2 on the same alarm. Signed requests to the relay commit to a hash of their body and carry a single-use nonce, so a captured request cannot be replayed or have its payload swapped.

A member's device keys are fixed once the relay has recorded them. Anyone in a room may introduce a new member — that is how an invite adds someone — but only the owner of a member card can change it, and never its keys. Clients enforce the same rule independently and will refuse a key change even if the relay sends one, showing a warning in the family panel instead; compare the safety code in person when you see it.

Local browser storage persists until the user clears site/app data, so attachments you have already opened stay on your device after the relay's copy expires.
