import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("public/icons", { recursive: true });
for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  const b64 = await readFile(`public/icons/${name}.b64`, "utf8");
  await writeFile(`public/icons/${name}`, Buffer.from(b64.replace(/\s+/g, ""), "base64"));
}
