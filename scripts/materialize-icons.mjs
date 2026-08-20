import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("public/icons", { recursive: true });
const icon192 = await readFile("public/icons/icon-192.png.b64", "utf8");
const icon512 = await readFile("public/icons/icon-512.png.b64", "utf8");
await writeFile("public/icons/icon-192.png", Buffer.from(icon192.trim(), "base64"));
await writeFile("public/icons/icon-512.png", Buffer.from(icon512.trim(), "base64"));
await writeFile("public/icons/icon-maskable-512.png", Buffer.from(icon512.trim(), "base64"));
