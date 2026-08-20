# Security

Kin encrypts message and attachment contents in the client before they reach Cloudflare. Conversation keys stay on paired devices. The Worker stores and forwards ciphertext; it can still see routing metadata such as room IDs/titles, member display names, public device keys, timestamps, sizes, and push subscriptions.

This v1 protocol uses long-lived P-256 device keys and AES-GCM conversation keys. It provides end-to-end confidentiality and signed message authenticity, but **does not yet provide Signal-style forward secrecy or post-compromise security**. Pairing displays a four-emoji safety code; compare it on both devices when adding someone.

Relay message envelopes and R2 attachments are configured for seven-day retention. Local browser storage persists until the user clears site/app data.
