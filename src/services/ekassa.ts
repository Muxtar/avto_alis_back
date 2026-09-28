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

const prisma = new PrismaClient();
const EKASSA_DOC_URL = 'https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/';
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

export interface ReceiptItem { name: string; searchQuery: string; qty: number; unit: string | null; price: number; total: number; vatPercent: number | null }
export interface ReceiptData {
  store: { objectName: string | null; address: string | null; objectCode: string | null; taxpayer: string | null; voen: string | null };
  receiptNo: string | null; cashier: string | null; date: string | null; time: string | null;
  items: ReceiptItem[];
  total: number | null; vatTotal: number | null;
  payment: { cashless: number; cash: number; bonus: number; prepayment: number; credit: number };
  fiscalId: string;
}

/** Çek şəklini portaldan al (sabit host — SSRF riski yoxdur). */
export class PortalUnreachable extends Error {}

export async function fetchReceiptImage(fiscalId: string): Promise<Buffer> {
  // İki cəhd — portal bəzən ilk qoşulmada gecikir.
  let res: Response | null = null;
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    res = await fetch(EKASSA_DOC_URL + encodeURIComponent(fiscalId), {
      headers: { 'User-Lang': 'az', Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 (tradixai receipt reader)' },
      signal: AbortSignal.timeout(12000),
    }).catch((e) => { lastErr = e; return null; });
  }
  if (!res) {
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

/** Çek şəklini AI ilə oxu (portal şəkli və ya kağız çekin fotosu). */
export async function readReceiptImage(image: Buffer, mediaType: 'image/jpeg' | 'image/png', fiscalHint?: string): Promise<ReceiptData> {
  return readReceiptSource({ type: 'base64', media_type: mediaType, data: image.toString('base64') }, fiscalHint);
}

/** Serverimiz portala çata bilməyəndə: şəkli Anthropic-in özü URL-dən götürür. */
export async function readReceiptFromPortalUrl(fiscalId: string): Promise<ReceiptData> {
  return readReceiptSource({ type: 'url', url: EKASSA_DOC_URL + encodeURIComponent(fiscalId) }, fiscalId);
}

async function readReceiptSource(source: any, fiscalHint?: string): Promise<ReceiptData> {
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
    messages: [{ role: 'user', content: [{ type: 'image', source }, { type: 'text', text: prompt }] }],
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
  let data: ReceiptData;
  try {
    const img = await fetchReceiptImage(fiscalId);
    data = await readReceiptImage(img, 'image/jpeg', fiscalId);
  } catch (e) {
    if (!(e instanceof PortalUnreachable)) throw e;
    // Serverimiz portala çata bilmədi (məs. hostinqin IP-si bloklanıb) — Anthropic şəkli özü alsın.
    try { data = await readReceiptFromPortalUrl(fiscalId); }
    catch (e2: any) {
      console.error('[ekassa] url fallback failed:', e2?.message);
      if (/tapılmadı|tanınmadı/.test(e2?.message || '')) throw e2;
      throw new Error('e-kassa portalına hazırda qoşulmaq alınmadı. «🖼 Şəkil» bölməsindən çekin fotosunu yükləyin — çek şəkildən oxunacaq.');
    }
  }
  const issuedAt = data.date ? new Date(`${data.date}T${/^\d{2}:\d{2}(:\d{2})?$/.test(data.time || '') ? data.time : '00:00:00'}+04:00`) : null;
  try {
    return await prisma.scannedReceipt.create({
      data: { fiscalId, storeName: data.store.objectName, voen: data.store.voen, total: data.total, issuedAt: issuedAt && !isNaN(issuedAt.getTime()) ? issuedAt : null, data: data as unknown as Prisma.InputJsonValue },
    });
  } catch {
    return prisma.scannedReceipt.findUniqueOrThrow({ where: { fiscalId } }); // paralel skan
  }
}

/** Hər məhsul üçün saytda oxşar elanlar (ən uyğun, sonra ən ucuz). */
export async function matchItems(items: ReceiptItem[]) {
  const now = new Date();
  return Promise.all(items.map(async (it) => {
    const words = searchWords(it.searchQuery || it.name).filter((w) => w.length >= 3).slice(0, 6);
    if (!words.length) return { matches: [] as any[] };
    const cands = await prisma.listing.findMany({
      where: {
        status: 'APPROVED', type: 'PRODUCT', archivedAt: null,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: words.map((w) => ({ title: { contains: w, mode: 'insensitive' as const } })) },
        ],
      },
      select: { id: true, title: true, price: true, images: true, city: true, stock: true, businessObjectId: true, businessObject: { select: { name: true } }, user: { select: { name: true } } },
      take: 40,
    });
    const need = Math.min(2, words.length);
    const scored = cands.map((l) => {
      const t = l.title.toLocaleLowerCase('az');
      return { l, score: words.filter((w) => t.includes(w)).length };
    }).filter((x) => x.score >= need).sort((a, b) => b.score - a.score || a.l.price - b.l.price).slice(0, 4);
    return {
      matches: scored.map(({ l, score }) => ({
        id: l.id, title: l.title, price: l.price, image: l.images?.[0] || null, city: l.city,
        seller: l.businessObject?.name || l.user?.name || null, score,
        cheaperBy: it.price > 0 && l.price < it.price ? Math.round((1 - l.price / it.price) * 100) : 0,
      })),
    };
  }));
}
