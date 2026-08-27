// Turn a raw generated image into usable assets: platform-sized crops with
// a title bar, so the picture is a product mockup rather than decoration.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { q } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'public');

// The sizes that actually matter for the channels we sell through.
const SIZES = [
  { key: 'social', w: 1200, h: 630 },   // link previews, listings
  { key: 'square', w: 1080, h: 1080 },  // marketplace thumbnail
  { key: 'vertical', w: 1080, h: 1350 },// portrait social
];

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function titleBar(w, h, title) {
  const barH = Math.round(h * 0.22);
  const size = Math.max(22, Math.round(w / 26));
  const text = esc(title).slice(0, 60);
  return Buffer.from(
    `<svg width="${w}" height="${h}">
       <rect x="0" y="${h - barH}" width="${w}" height="${barH}"
             fill="#0c2e2c" fill-opacity="0.88"/>
       <text x="${Math.round(w * 0.05)}" y="${h - Math.round(barH / 2) + size / 3}"
             font-family="Helvetica,Arial,sans-serif" font-size="${size}"
             font-weight="bold" fill="#ffd166">${text}</text>
     </svg>`
  );
}

export async function makeMockups(taskId, srcRel, title) {
  const src = path.join(PUB, srcRel);
  await fs.access(src);
  const outDir = path.join(PUB, 'mockups');
  await fs.mkdir(outDir, { recursive: true });

  const made = [];
  for (const s of SIZES) {
    const name = 'task' + taskId + '-' + s.key + '-' + Date.now() + '.png';
    const dest = path.join(outDir, name);
    await sharp(src)
      .resize(s.w, s.h, { fit: 'cover', position: 'attention' })
      .composite([{ input: titleBar(s.w, s.h, title), top: 0, left: 0 }])
      .png({ quality: 90 })
      .toFile(dest);
    const rel = 'mockups/' + name;
    await q(
      `INSERT INTO assets (task_id, kind, path, prompt, model)
       VALUES ($1,'mockup',$2,$3,'sharp')`,
      [taskId, rel, s.key + ' ' + s.w + 'x' + s.h]
    );
    made.push(rel);
  }
  return made;
}
