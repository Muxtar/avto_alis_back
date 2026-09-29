// E-KASSA ÇEKİ — QR oxunur, çek dövlət portalından alınır, AI ilə strukturlaşdırılır.
//
// Çekin QR-ı: https://monitoring.e-kassa.gov.az/#/index?doc=<fiskal ID>
// Portalın «Çeki yüklə» səhifəsi çeki ŞƏKİL kimi qaytarır (açıq endpoint, giriş tələb etmir):
//   GET https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/<fiskal ID>
//   (User-Lang: az → Azərbaycan dilində çek)
// Şəkli Claude vision oxuyur → mağaza, VÖEN, tarix, məhsullar, cəm, ödəniş.
// Eyni çek bir dəfə analiz olunur (fiskal ID ilə keş) — AI xərci təkrarlanmır.
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient, Prisma } from '@prisma/client';
import { searchWords } from './searchTerms';
import { ocrImage, parseReceiptText } from './receiptOcr';
import { isRestrictedGtin } from './gtin';

const prisma = new PrismaClient();
const EKASSA_DOC_URL = 'https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/';
// Portal YALNIZ Azərbaycan IP-lərinə açıqdır. Azərbaycanda kiçik proxy qurulubsa
// (tools/ekassa-proxy), çek onun üzərindən avtomatik alınır:
//   EKASSA_PROXY_URL=https://ekassa-proxy.example.az   EKASSA_PROXY_KEY=<gizli açar>
const PROXY_URL = (process.env.EKASSA_PROXY_URL || '').replace(/\/+$/, '');
const PROXY_KEY = process.env.EKASSA_PROXY_KEY || '';
const AI_MODEL = process.env.RECEIPT_AI_MODEL || process.env.CREDENTIAL_AI_MODEL || 'claude-sonnet-5';
// Fiskal ID — base58 (portalın öz yoxlaması: /^[A-HJ-NP-Za-km-z1-9]*$/).
const FISCAL_RE = /^[A-HJ-NP-Za-km-z1-9]{10,64}$/;

let client: Anthropic | null = null;
const ai = () => (process.env.ANTHROPIC_API_KEY ? (client ||= new Anthropic()) : null);

/** QR mətni / link / fiskal ID → fiskal ID (yoxdursa null). */
export function parseFiscalId(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const m = raw.match(/[?&#]doc=([A-Za-z0-9]+)/);
  const cand = m ? m[1] : raw;
  if (m && !/e-kassa\.gov\.az/i.test(raw)) return null; // yalnız dövlət portalının linki
  return FISCAL_RE.test(cand) ? cand : null;
}

export interface ReceiptItem {
  name: string; searchQuery: string; qty: number; unit: string | null; price: number; total: number; vatPercent: number | null;
  barcode?: string | null;           // GTIN (yoxlama rəqəmi ilə təsdiqli)
  check?: 'ok' | 'mismatch';          // say × qiymət = cəm?
}
export interface ReceiptData {
  store: { objectName: string | null; address: string | null; objectCode: string | null; taxpayer: string | null; voen: string | null };
  receiptNo: string | null; cashier: string | null; date: string | null; time: string | null;
  items: ReceiptItem[];
  total: number | null; vatTotal: number | null;
  payment: { cashless: number; cash: number; bonus: number; prepayment: number; credit: number };
  fiscalId: string;
  source?: 'ocr' | 'ai';
  checks?: { itemsSum: number; totalMatches: boolean; confidence: number };
}

// Ödənişli AI yalnız açıq-aydın icazə veriləndə (OCR heç nə tapmayanda) — default BAĞLI.
const AI_FALLBACK = process.env.RECEIPT_AI_FALLBACK === '1';

/** Çek şəklini portaldan al (sabit host — SSRF riski yoxdur). */
export class PortalUnreachable extends Error {}

// e-kassa portalı yalnız Azərbaycan IP-lərinə açıqdır — xarici hostinqdən (Railway,
// Anthropic) qoşulma TIMEOUT olur (yoxlanılıb: UND_ERR_CONNECT_TIMEOUT). Hər skanda
// 10+ saniyə gözləməmək üçün portal əlçatmazdırsa 10 dəqiqə birbaşa foto yoluna keçirik.
let portalDownUntil = 0;
export const portalLikelyDown = () => Date.now() < portalDownUntil;

export async function fetchReceiptImage(fiscalId: string): Promise<Buffer> {
  if (portalLikelyDown()) throw new PortalUnreachable('e-kassa portalı əlçatan deyil');
  // İki cəhd — portal bəzən ilk qoşulmada gecikir.
  let res: Response | null = null;
  let lastErr: any = null;
  const url = PROXY_URL ? `${PROXY_URL}/doc/${encodeURIComponent(fiscalId)}` : EKASSA_DOC_URL + encodeURIComponent(fiscalId);
  res = await fetch(url, {
    headers: { 'User-Lang': 'az', Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 (tradixai receipt reader)', ...(PROXY_KEY ? { 'X-Proxy-Key': PROXY_KEY } : {}) },
    signal: AbortSignal.timeout(PROXY_URL ? 15000 : 7000),
  }).catch((e) => { lastErr = e; return null; });
  if (!res) {
    portalDownUntil = Date.now() + 10 * 60 * 1000;
    // Səbəb loglarda görünsün (DNS, TLS, timeout, firewall…).
    console.error('[ekassa] portal fetch failed:', lastErr?.name, lastErr?.cause?.code || lastErr?.cause?.message || lastErr?.message);
    throw new PortalUnreachable('e-kassa portalına qoşulmaq alınmadı');
  }
  // Portal olmayan çek üçün 209 + «Kassa çeki tapılmamışdır» ŞƏKLİ qaytarır — onu AI-ya vermirik.
  if (res.status === 404 || res.status === 209) throw new Error('Kassa çeki tapılmadı. Yeni vurulmuş çek portalda bir az gec görünə bilər; 7 gün ərzində tapılmasa Dövlət Vergi Xidmətinə müraciət edin.');
  if (res.status !== 200 || !(res.headers.get('content-type') || '').startsWith('image/')) throw new Error(`e-kassa çeki qaytarmadı (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error('Çek şəkli boş gəldi');
  return buf;
}

const num = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

/**
 * Çek şəklini oxu — PULSUZ: Tesseract OCR + qaydalarla təhlil (services/receiptOcr).
 * Ödənişli AI yalnız RECEIPT_AI_FALLBACK=1 olanda və OCR heç bir məhsul tapmayanda.
 */
export async function readReceiptImage(image: Buffer, mediaType: 'image/jpeg' | 'image/png', fiscalHint?: string): Promise<ReceiptData> {
  const { text, confidence } = await ocrImage(image);
  if (/Kassa çeki tapılmamışdır|tapılmamışdır/i.test(text)) throw new Error('Kassa çeki tapılmadı (portalda yoxdur). 7 gün ərzində tapılmasa Dövlət Vergi Xidmətinə müraciət edin.');
  const p = parseReceiptText(text, confidence);
  if (!p.items.length) {
    if (AI_FALLBACK && ai()) return { ...(await readReceiptSource({ type: 'base64', media_type: mediaType, data: image.toString('base64') }, fiscalHint)), source: 'ai' };
    throw new Error('Çekdə məhsul cədvəli oxunmadı. e-kassadan yüklənmiş çeki (document.jpg) seçin və ya daha aydın şəkil çəkin.');
  }
  return {
    store: p.store, receiptNo: p.receiptNo, cashier: p.cashier, date: p.date, time: p.time,
    items: p.items.map((i) => ({ name: i.name, searchQuery: i.name, qty: i.qty, unit: i.unit, price: i.price, total: i.total, vatPercent: i.vatPercent, barcode: i.barcode, check: i.check })),
    total: p.total, vatTotal: p.vatTotal, payment: p.payment,
    fiscalId: fiscalHint || p.shortFiscalId || '',
    source: 'ocr', checks: p.checks,
  };
}

/** PDF — OCR PDF-i birbaşa oxumur; e-kassa «Çeki yüklə» onsuz da JPG verir. */
export async function readReceiptPdf(pdf: Buffer, fiscalHint?: string): Promise<ReceiptData> {
  if (AI_FALLBACK && ai()) return { ...(await readReceiptSource({ type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') }, fiscalHint, 'document')), source: 'ai' };
  throw new Error('PDF çek hazırda oxunmur — e-kassadakı «Çeki yüklə» ilə düşən JPG faylını (document.jpg) seçin.');
}

// ── MAĞAZA QİYMƏTLƏRİ ──
export const nameKeyOf = (s: string) => searchWords(s).join(' ').slice(0, 160) || s.toLocaleLowerCase('az').trim();

/** Çekdəki qiymətləri anonim müşahidə kimi yaz (eyni çek bir dəfə). */
export async function recordStorePrices(rec: { id: number; data: any; issuedAt: Date | null; createdAt: Date }) {
  const d = rec.data as ReceiptData;
  const when = rec.issuedAt || rec.createdAt;
  for (const it of d.items || []) {
    if (!(it.price > 0) || it.check === 'mismatch') continue; // şübhəli sətir bazaya düşmür
    const nameKey = nameKeyOf(it.name);
    await prisma.storePrice.upsert({
      where: { receiptId_nameKey: { receiptId: rec.id, nameKey } },
      update: {},
      create: { receiptId: rec.id, barcode: it.barcode || null, nameKey, name: it.name, storeName: d.store?.objectName || null, voen: d.store?.voen || null, objectCode: d.store?.objectCode || null, unit: it.unit, unitPrice: it.price, observedAt: when },
    }).catch(() => {});
  }
}

async function readReceiptSource(source: any, fiscalHint?: string, blockType: 'image' | 'document' = 'image'): Promise<ReceiptData> {
  const c = ai();
  if (!c) throw new Error('Çek analizi hazırda aktiv deyil (AI açarı yoxdur)');
  const prompt = `Bu Azərbaycan e-kassa satış çekidir. Yalnız JSON qaytar (başqa mətn yox):
{"store":{"objectName":"","address":"","objectCode":"","taxpayer":"","voen":""},"receiptNo":"","cashier":"","date":"YYYY-MM-DD","time":"HH:MM:SS",
"items":[{"name":"çekdəki ad olduğu kimi","searchQuery":"məhsulun anlaşıqlı adı axtarış üçün (qısaltmaları aç, marka + məhsul növü + həcm/çəki, Azərbaycan dilində, məs. «Activia qara gavalılı yoqurt»)","qty":1,"unit":"ədəd|kq|l|...","price":0,"total":0,"vatPercent":18}],
"total":0,"vatTotal":0,"payment":{"cashless":0,"cash":0,"bonus":0,"prepayment":0,"credit":0},"fiscalId":""}
Rəqəmləri çekdəki kimi ver (nöqtə ilə). Oxunmayan sahəni null qoy. Çek ingiliscə ola bilər — sahələri yenə doldur.
Şəkildə «Kassa çeki tapılmamışdır» / «receipt not found» yazılıbsa {"error":"not_found"} qaytar. Çek deyilsə {"error":"not_receipt"} qaytar.`;
  const r = await c.messages.create({
    model: AI_MODEL, max_tokens: 2500,
    messages: [{ role: 'user', content: [{ type: blockType, source } as any, { type: 'text', text: prompt }] }],
  });
  const text = r.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let d: any;
  try { d = JSON.parse(json); } catch { throw new Error('Çek oxunmadı — şəkil aydın deyil'); }
  if (d.error === 'not_found') throw new Error('Kassa çeki tapılmadı. Yeni vurulmuş çek portalda bir az gec görünə bilər; 7 gün ərzində tapılmasa Dövlət Vergi Xidmətinə müraciət edin.');
  if (d.error) throw new Error('Şəkildə e-kassa çeki tanınmadı');
  const items: ReceiptItem[] = (Array.isArray(d.items) ? d.items : []).slice(0, 200).map((i: any) => ({
    name: String(i.name || '').trim().slice(0, 200),
    searchQuery: String(i.searchQuery || i.name || '').trim().slice(0, 200),
    qty: num(i.qty) || 1, unit: i.unit ? String(i.unit).slice(0, 20) : null,
    price: num(i.price), total: num(i.total) || num(i.price) * (num(i.qty) || 1),
    vatPercent: i.vatPercent == null ? null : num(i.vatPercent),
  })).filter((i: ReceiptItem) => i.name);
  if (!items.length) throw new Error('Çekdə məhsul tapılmadı');
  const s = d.store || {};
  return {
    store: { objectName: s.objectName || null, address: s.address || null, objectCode: s.objectCode || null, taxpayer: s.taxpayer || null, voen: s.voen ? String(s.voen).replace(/\D/g, '') || null : null },
    receiptNo: d.receiptNo ? String(d.receiptNo) : null, cashier: d.cashier || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : null, time: d.time || null,
    items, total: d.total == null ? null : num(d.total), vatTotal: d.vatTotal == null ? null : num(d.vatTotal),
    payment: { cashless: num(d.payment?.cashless), cash: num(d.payment?.cash), bonus: num(d.payment?.bonus), prepayment: num(d.payment?.prepayment), credit: num(d.payment?.credit) },
    fiscalId: fiscalHint || String(d.fiscalId || ''),
  };
}

/** Fiskal ID ilə çek — keşdə varsa onu, yoxdursa portaldan alıb analiz et. */
export async function getReceipt(fiscalId: string) {
  const cached = await prisma.scannedReceipt.findUnique({ where: { fiscalId } });
  if (cached) return cached;
  // Portal əlçatmazdırsa PortalUnreachable yuxarı qalxır — marşrut istifadəçidən çekin fotosunu istəyir.
  const img = await fetchReceiptImage(fiscalId);
  const data = await readReceiptImage(img, 'image/jpeg', fiscalId);
  const issuedAt = data.date ? new Date(`${data.date}T${/^\d{2}:\d{2}(:\d{2})?$/.test(data.time || '') ? data.time : '00:00:00'}+04:00`) : null;
  try {
    const rec = await prisma.scannedReceipt.create({
      data: { fiscalId, storeName: data.store.objectName, voen: data.store.voen, total: data.total, issuedAt: issuedAt && !isNaN(issuedAt.getTime()) ? issuedAt : null, data: data as unknown as Prisma.InputJsonValue },
    });
    await recordStorePrices(rec);
    return rec;
  } catch {
    return prisma.scannedReceipt.findUniqueOrThrow({ where: { fiscalId } }); // paralel skan
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Hər məhsul üçün:
 *   1) saytda EYNİ ŞTRİX-KODLU elanlar (dəqiq uyğunluq, ən ucuz əvvəl);
 *   2) yoxdursa — ad oxşarlığı (təxmini);
 *   3) digər mağazalardakı qiymətlər (başqa çeklərdən, son 90 gün).
 * Çəki ilə satılan / daxili kodlar (20–29…) başqa mağaza ilə müqayisə edilmir.
 */
export async function matchItems(items: ReceiptItem[], excludeReceiptId?: number) {
  const now = new Date();
  const since = new Date(Date.now() - 90 * 864e5);
  const live = { status: 'APPROVED' as const, type: 'PRODUCT' as const, archivedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const sel = { id: true, title: true, price: true, images: true, city: true, stock: true, barcode: true, businessObject: { select: { name: true } }, user: { select: { name: true } } };
  return Promise.all(items.map(async (it) => {
    const code = it.barcode && !isRestrictedGtin(it.barcode) ? it.barcode : null;
    let exact: any[] = [];
    if (code) exact = await prisma.listing.findMany({ where: { ...live, barcode: code }, select: sel, orderBy: { price: 'asc' }, take: 4 });
    let fuzzy: any[] = [];
    if (!exact.length) {
      const words = searchWords(it.searchQuery || it.name).filter((w) => w.length >= 3).slice(0, 6);
      if (words.length) {
        const cands = await prisma.listing.findMany({ where: { ...live, AND: [{ OR: words.map((w) => ({ title: { contains: w, mode: 'insensitive' as const } })) }] }, select: sel, take: 40 });
        const need = Math.min(2, words.length);
        fuzzy = cands.map((l) => ({ l, score: words.filter((w) => l.title.toLocaleLowerCase('az').includes(w)).length }))
          .filter((x) => x.score >= need).sort((a, b) => b.score - a.score || a.l.price - b.l.price).slice(0, 4).map((x) => x.l);
      }
    }
    const shape = (l: any, exactMatch: boolean) => ({
      id: l.id, title: l.title, price: l.price, image: l.images?.[0] || null, city: l.city,
      seller: l.businessObject?.name || l.user?.name || null, exact: exactMatch,
      cheaperBy: it.price > 0 && l.price < it.price ? Math.round((1 - l.price / it.price) * 100) : 0,
      diffTotal: it.price > 0 ? r2((it.price - l.price) * it.qty) : 0, // + → saytda ucuz
    });
    // Digər mağazalar — hər mağazadan ən son qiymət, ucuzdan bahaya.
    const obs = code || !it.barcode
      ? await prisma.storePrice.findMany({
          where: { observedAt: { gte: since }, ...(excludeReceiptId ? { receiptId: { not: excludeReceiptId } } : {}), ...(code ? { barcode: code } : { nameKey: nameKeyOf(it.name) }) },
          orderBy: { observedAt: 'desc' }, take: 50,
        })
      : [];
    const byStore = new Map<string, any>();
    for (const o of obs) { const k = `${o.voen || ''}|${o.storeName || ''}`; if (!byStore.has(k)) byStore.set(k, o); }
    const otherStores = [...byStore.values()].sort((a, b) => a.unitPrice - b.unitPrice).slice(0, 4)
      .map((o) => ({ store: o.storeName, price: o.unitPrice, observedAt: o.observedAt, exact: !!code, diff: r2(it.price - o.unitPrice) }));
    return {
      matchType: exact.length ? 'barcode' : fuzzy.length ? 'name' : 'none',
      restricted: !!(it.barcode && isRestrictedGtin(it.barcode)),
      matches: (exact.length ? exact.map((l) => shape(l, true)) : fuzzy.map((l) => shape(l, false))),
      otherStores,
    };
  }));
}

/** Çek üzrə yekun: çekdə ödənilən vs saytda (ən ucuz uyğun elanla) alınsaydı. */
export function receiptTotals(items: ReceiptItem[], matched: { matches: any[] }[]) {
  let paid = 0, matchedPaid = 0, site = 0, found = 0;
  items.forEach((it, i) => {
    paid += it.total;
    const best = [...(matched[i]?.matches || [])].sort((a, b) => a.price - b.price)[0];
    if (best) { found++; matchedPaid += it.total; site += best.price * it.qty; }
  });
  return { paid: r2(paid), found, matchedPaid: r2(matchedPaid), siteTotal: r2(site), saving: r2(matchedPaid - site) };
}
