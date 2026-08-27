// Turn a draft into an actual sellable file: a real PDF or spreadsheet,
// not a description of one. This is what a customer downloads.

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { q } from './db.js';
import { askJSON } from './claude.js';
import { policyBlock } from './policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_DIR = path.join(__dirname, 'public', 'files');

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

// Ask the agent for the product itself, as structure we can render.
export async function spec(task) {
  return askJSON({
    maxTokens: 3000,
    system:
      policyBlock() +
      '\n\nYou produce the ACTUAL deliverable file, not a description of it. ' +
      'Write real, usable content a customer would pay for: real headings, ' +
      'real prompts, real rows, real checklists. No placeholders like ' +
      '"[insert here]". No lorem ipsum.\n\n' +
      'Reply with ONLY JSON, no markdown fences.\n' +
      'For a document: {"format":"pdf","title":"...","subtitle":"...",' +
      '"sections":[{"heading":"...","body":"...","bullets":["..."]}]}\n' +
      'For a spreadsheet or tracker: {"format":"xlsx","title":"...",' +
      '"sheets":[{"name":"...","columns":["..."],"rows":[["..."]]}]}\n' +
      'Pick whichever format genuinely suits the product. 6-12 sections, or ' +
      '2-4 sheets with 10+ real rows each. Include a short final section ' +
      'stating AI assistance was used and the buyer\'s refund rights.',
    user:
      'Build the deliverable for:\nTitle: ' + task.title +
      '\nCategory: ' + task.category +
      '\nBrief: ' + task.brief +
      '\n\nOutline already drafted:\n' + (task.output || '').slice(0, 2000),
  });
}

async function renderPDF(s, file) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const out = createWriteStream(file);
    doc.pipe(out);

    doc.fontSize(26).fillColor('#123f3b').text(s.title || 'Untitled');
    if (s.subtitle) doc.moveDown(0.3).fontSize(12).fillColor('#6b8f89').text(s.subtitle);
    doc.moveDown(1.2);

    for (const sec of s.sections || []) {
      if (doc.y > 690) doc.addPage();
      doc.fontSize(15).fillColor('#0e3d3a').text(sec.heading || '');
      doc.moveDown(0.35);
      if (sec.body) {
        doc.fontSize(11).fillColor('#222').text(sec.body, { align: 'left', lineGap: 2.5 });
        doc.moveDown(0.35);
      }
      for (const b of sec.bullets || []) {
        doc.fontSize(11).fillColor('#333').text('•  ' + b, { indent: 12, lineGap: 2 });
      }
      doc.moveDown(0.9);
    }
    doc.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

async function renderXLSX(s, file) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Unduruz Industries';
  for (const sh of s.sheets || []) {
    const ws = wb.addWorksheet((sh.name || 'Sheet').slice(0, 30));
    if (sh.columns?.length) {
      ws.addRow(sh.columns);
      ws.getRow(1).font = { bold: true, color: { argb: 'FF123F3B' } };
      ws.getRow(1).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EDE8' },
      };
      ws.columns = sh.columns.map(() => ({ width: 26 }));
    }
    for (const r of sh.rows || []) ws.addRow(r);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  await wb.xlsx.writeFile(file);
}

export async function build(task) {
  const s = await spec(task);
  await fs.mkdir(FILE_DIR, { recursive: true });
  const ext = s.format === 'xlsx' ? 'xlsx' : 'pdf';
  const name = slug(task.title) + '-' + task.id + '.' + ext;
  const full = path.join(FILE_DIR, name);

  if (ext === 'xlsx') await renderXLSX(s, full);
  else await renderPDF(s, full);

  const rel = 'files/' + name;
  await q(
    `INSERT INTO assets (task_id, kind, path, prompt, model)
     VALUES ($1,$2,$3,$4,'claude')`,
    [task.id, ext, rel, s.title || task.title]
  );
  return rel;
}
