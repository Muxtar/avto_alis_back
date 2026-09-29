// E-KASSA ÇEKİNİ PULSUZ OXU — Tesseract OCR (açıq mənbə, aze+eng) + qaydalarla təhlil.
// Ödənişli AI tələb olunmur. e-kassa portalının çek şəkli təmiz rəqəmsal render-dir,
// Tesseract onu yüksək dəqiqliklə oxuyur; kağız fotoda dəqiqlik aşağı ola bilər.
//
// Təhlil: «Məhsulun adı … Say Qiymət Cəmi» başlığı ilə «Cəmi» arasındakı cədvəl.
//   AD (vahid) SAY QİYMƏT CƏM   — bir sətir; ad iki sətrə bölünə bilər
//   *ƏDV: 18%                    — (OCR bəzən «1896» oxuyur)
//   4760012345678                — ştrix-kod (varsa; yoxlama rəqəmi ilə təsdiq)
// Arifmetik yoxlama: say × qiymət = cəm, sətirlərin cəmi = «Cəmi».
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { normalizeGtin } from './gtin';

let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
function getWorker(): Promise<Worker> {
  if (!worker) {
    worker = (async () => {
      const w = await createWorker(['aze', 'eng']);
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
      return w;
    })().catch((e) => { worker = null; throw e; });
  }
  return worker;
}

/** Şəkli mətnə çevir (bir worker, növbə ilə — yaddaşı qoruyur). */
export async function ocrImage(img: Buffer): Promise<{ text: string; confidence: number }> {
  const pre = await sharp(img).rotate().grayscale().resize({ width: 1100, withoutEnlargement: false }).normalise().sharpen().png().toBuffer();
  const run = queue.then(async () => {
    const w = await getWorker();
    const { data } = await w.recognize(pre);
    return { text: data.text || '', confidence: data.confidence || 0 };
  });
  queue = run.catch(() => undefined);
  return run;
}

const num = (s: string | undefined) => {
  if (!s) return NaN;
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.').replace(/[oO]/g, '0'));
  return Number.isFinite(n) ? n : NaN;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const after = (text: string, re: RegExp) => { const m = text.match(re); return m ? m[1].trim() : null; };

export interface ParsedItem { name: string; unit: string | null; qty: number; price: number; total: number; vatPercent: number | null; barcode: string | null; check: 'ok' | 'mismatch' }
export interface ParsedReceipt {
  store: { objectName: string | null; address: string | null; objectCode: string | null; taxpayer: string | null; voen: string | null };
  receiptNo: string | null; cashier: string | null; date: string | null; time: string | null;
  items: ParsedItem[];
  total: number | null; vatTotal: number | null;
  payment: { cashless: number; cash: number; bonus: number; prepayment: number; credit: number };
  shortFiscalId: string | null;
  checks: { itemsSum: number; totalMatches: boolean; confidence: number };
}

// Məhsul sətri: «AD (vahid) SAY QİYMƏT CƏM»; vahid mötərizəsiz də ola bilər.
const ITEM_RE = /^(.*?)\s*(?:\(\s*([A-Za-zƏəÖöÜüĞğŞşÇçİıI.]{1,8})\s*\))?\s+(\d+(?:[.,]\d+)?)\s+(\d+[.,]\d{1,3})\s+(\d+[.,]\d{2})\s*$/u;

export function parseReceiptText(text: string, confidence = 0): ParsedReceipt {
  const lines = text.split('\n').map((l) => l.replace(/[“”"«»]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const full = lines.join('\n');
  // Mağaza: ünvan və vergi ödəyicisi bir neçə sətrə yayıla bilər.
  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const joinUntil = (start: number, first: string, stop: RegExp) => {
    let out = first;
    for (let i = start + 1; i < Math.min(lines.length, start + 4) && !stop.test(lines[i]); i++) out += ' ' + lines[i];
    return out.trim();
  };
  const addrI = idx(/Obyektin ünvanı/i);
  const taxI = idx(/Vergi ödəyicisinin adı/i);
  const store = {
    objectName: after(full, /Obyektin adı:\s*(.+)/i),
    address: addrI >= 0 ? joinUntil(addrI, lines[addrI].replace(/.*ünvanı:\s*/i, ''), /Obyektin kodu|Vergi/i) : null,
    objectCode: after(full, /Obyektin kodu:\s*([\d-]+)/i),
    taxpayer: taxI >= 0 ? joinUntil(taxI, lines[taxI].replace(/.*adı:\s*/i, ''), /V[ÖO]EN/i) : null,
    voen: (after(full, /V[ÖO]EN:?\s*(\d{10})/i) || null),
  };
  const dm = full.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const tm = full.match(/Vaxt:?\s*(\d{2}:\d{2}(?::\d{2})?)/i);

  // ── Məhsul cədvəli ──
  const head = idx(/Məhsulun adı|Mehsulun adi/i);
  const endRel = lines.slice(head + 1).findIndex((l) => /^C[əe]mi\b/i.test(l));
  const body = head >= 0 ? lines.slice(head + 1, endRel >= 0 ? head + 1 + endRel : undefined) : [];
  const items: ParsedItem[] = [];
  let pendingName = '';
  for (const raw of body) {
    const l = raw.replace(/\s+/g, ' ');
    if (/^[.*•\-–—=_\s]+$/.test(l) || /^[.\s]{6,}/.test(l)) continue;           // ulduz/nöqtə ayırıcıları
    const vat = l.match(/Ə?DV[:\s]*(\d{1,2})\s*(?:%|96|9o)/i);                 // «ƏDV: 18%» (OCR: «1896»)
    if (vat && items.length) { items[items.length - 1].vatPercent = Number(vat[1]); continue; }
    const digits = l.replace(/[\s-]/g, '');
    if (/^\d{8,14}$/.test(digits) && items.length) {                           // ştrix-kod sətri
      items[items.length - 1].barcode = normalizeGtin(digits); continue;
    }
    const m = l.match(ITEM_RE);
    if (m) {
      const name = `${pendingName} ${m[1]}`.replace(/\s+/g, ' ').trim();
      pendingName = '';
      const qty = num(m[3]), price = num(m[4]), total = num(m[5]);
      if (!name || !Number.isFinite(qty) || !Number.isFinite(total)) continue;
      items.push({ name, unit: m[2] ? m[2].toLowerCase() : null, qty, price, total, vatPercent: null, barcode: null, check: Math.abs(r2(qty * price) - total) <= 0.02 ? 'ok' : 'mismatch' });
    } else if (!/\d{1,}[.,]\d{2}\s*$/.test(l)) {
      pendingName = `${pendingName} ${l}`.trim().slice(0, 120);                // adın birinci hissəsi (sətir bölünüb)
    }
  }
  const total = num(after(full, /^C[əe]mi\s+(\d+[.,]\d{2})/im) || '');
  const vatTotal = num(after(full, /Toplam vergi\s*[—–=-]?\s*(\d+[.,]\d{2})/i) || '');
  const pay = (re: RegExp) => { const v = num(after(full, re) || ''); return Number.isFinite(v) ? v : 0; };
  const itemsSum = r2(items.reduce((s, i) => s + i.total, 0));
  return {
    store,
    receiptNo: after(full, /Sat\S*\s+\S*eki\s*(?:N|№)\S*\s*(\d{3,})/i) || after(full, /(?:N|№)[°º:.]?\s*(\d{5,})/),
    cashier: after(full, /Kassir:\s*([A-ZƏÖÜĞŞÇİ][A-ZƏÖÜĞŞÇİa-zəöüğşçı. ]+?)(?:\s{2,}|\s+Tarix|$)/),
    date: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null,
    time: tm ? tm[1] : null,
    items,
    total: Number.isFinite(total) ? total : null,
    vatTotal: Number.isFinite(vatTotal) ? vatTotal : null,
    payment: { cashless: pay(/Nağdsız:\s*(\d+[.,]\d{2})/i), cash: pay(/Nağd:\s*(\d+[.,]\d{2})/i), bonus: pay(/Bonus:\s*(\d+[.,]\d{2})/i), prepayment: pay(/Avans[^:]*:\s*(\d+[.,]\d{2})/i), credit: pay(/Nisyə:\s*(\d+[.,]\d{2})/i) },
    shortFiscalId: after(full, /Fiskal [İI]D:\s*([A-Za-z0-9]+)/i),
    checks: { itemsSum, totalMatches: Number.isFinite(total) && Math.abs(itemsSum - total) <= 0.05, confidence },
  };
}
