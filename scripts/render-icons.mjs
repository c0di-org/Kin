/**
 * Renders the Kin app icon (three candy beads on a candy-glass gradient) into the
 * base64 PNG blobs that `materialize-icons.mjs` unpacks at build time.
 *
 * Run after changing the brand: `node scripts/render-icons.mjs`.
 * Hand-rolled so the repo needs no image toolchain — plain math plus zlib.
 */
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";

const SS = 3; // supersampling factor, for smooth edges
const STOPS = [[0x45, 0xc2, 0xff], [0x8a, 0x7b, 0xff], [0xff, 0x77, 0xbd]];
const BEADS = [{ x: .332, y: .371 }, { x: .668, y: .371 }, { x: .5, y: .664 }];

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge0, edge1, v) => { const t = clamp01((v - edge0) / (edge1 - edge0)); return t * t * (3 - 2 * t); };

/** Diagonal sky → grape → bubblegum sweep. */
function background(u, v) {
  const t = clamp01((u * .58 + v * .42));
  const seg = t < .5 ? 0 : 1;
  const local = t < .5 ? t / .5 : (t - .5) / .5;
  const [a, b] = [STOPS[seg], STOPS[seg + 1]];
  const lift = 1 + .08 * (1 - v); // a little more light up top
  return [mix(a[0], b[0], local) * lift, mix(a[1], b[1], local) * lift, mix(a[2], b[2], local) * lift];
}

function shade(u, v, { radius, corner }) {
  // rounded-rect coverage (corner = 0 for a full-bleed maskable icon)
  const dx = Math.max(Math.abs(u - .5) - (.5 - corner), 0);
  const dy = Math.max(Math.abs(v - .5) - (.5 - corner), 0);
  if (Math.hypot(dx, dy) > corner) return null;

  let [r, g, b] = background(u, v);
  for (const bead of BEADS) { // soft drop shadow under each bead
    const d = Math.hypot(u - bead.x, v - (bead.y + .028));
    const s = (1 - smooth(radius - .02, radius + .06, d)) * .16;
    r *= 1 - s; g *= 1 - s; b *= 1 - s;
  }
  for (const bead of BEADS) {
    const d = Math.hypot(u - bead.x, v - bead.y);
    if (d > radius) continue;
    // glossy plastic bead: bright top-left highlight fading to a cool underside
    const gloss = clamp01(1 - Math.hypot(u - (bead.x - radius * .34), v - (bead.y - radius * .38)) / (radius * 1.25));
    const under = smooth(radius * .5, radius, d) * .07;
    const tint = mix(0.975, 1, gloss * gloss);
    r = 255 * tint - under * 26; g = 255 * tint - under * 18; b = 255 * (tint + .012) - under * 4;
  }
  return [r, g, b];
}

function render(size, opts) {
  const n = size * SS;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x * SS + sx + .5) / n, (y * SS + sy + .5) / n, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const samples = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(clamp01(r / samples / 255) * 255);
      px[i + 1] = Math.round(clamp01(g / samples / 255) * 255);
      px[i + 2] = Math.round(clamp01(b / samples / 255) * 255);
      px[i + 3] = Math.round(a / samples);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 4; // Paeth: gradients compress far better than unfiltered rows
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? px[y * stride + i - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 4 ? px[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[row + 1 + i] = (px[y * stride + i] - pred) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const rounded = { radius: .152, corner: .235 };
const maskable = { radius: .118, corner: .5 }; // full-bleed circle-safe, beads inside the safe zone
const write = async (name, size, opts) =>
  writeFile(`public/icons/${name}.b64`, png(size, render(size, opts)).toString("base64").replace(/(.{96})/g, "$1\n") + "\n");

await write("icon-192.png", 192, rounded);
await write("icon-512.png", 512, rounded);
await write("icon-maskable-512.png", 512, maskable);
console.log("icons rendered");
