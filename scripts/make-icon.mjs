// Draws Spark's app icon (an orange ✻ on a soft rounded square) as a 1024px
// PNG with no dependencies. Then: npx tauri icon scripts/icon-1024.png
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const S = 1024;
const SS = 3; // supersampling for smooth edges
const px = Buffer.alloc(S * S * 4);
const bg = [250, 246, 241];
const fg = [217, 119, 87];

function inRoundedSquare(x, y) {
  const m = 56; const r = 220;
  const cx = Math.min(Math.max(x, m + r), S - m - r);
  const cy = Math.min(Math.max(y, m + r), S - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && x <= S - m && y >= m && y <= S - m;
}

function inStar(x, y) {
  const dx = x - S / 2; const dy = y - S / 2;
  const len = 300; const half = 48;
  for (let k = 0; k < 3; k++) { // three bars -> six arms
    const a = (Math.PI / 3) * k + Math.PI / 2;
    const ux = Math.cos(a); const uy = Math.sin(a);
    const along = dx * ux + dy * uy;
    const across = -dx * uy + dy * ux;
    const t = Math.max(-len, Math.min(len, along)); // capsule: rounded ends
    if ((along - t) ** 2 + across ** 2 <= half * half) return true;
  }
  return false;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let cover = 0; let star = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const X = x + (sx + 0.5) / SS; const Y = y + (sy + 0.5) / SS;
        if (inRoundedSquare(X, Y)) { cover++; if (inStar(X, Y)) star++; }
      }
    }
    const n = SS * SS;
    const t = cover ? star / cover : 0;
    const i = (y * S + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(bg[c] * (1 - t) + fg[c] * t);
    px[i + 3] = Math.round((cover / n) * 255);
  }
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(new URL('./icon-1024.png', import.meta.url), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote scripts/icon-1024.png');
