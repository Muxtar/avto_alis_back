// Tavily İNDEKSİ ilə elan axtarışı — prod server tap.az / turbo.az / lalafo.az-a
// birbaşa çata bilməyəndə (Cloudflare bütün server IP-lərinə 403 qaytarır, bax
// yaddaş: az-sites-cloudflare-block) əsas mənbə budur.
//
// Tavily həmin saytları öz indeksindən qaytarır: konkret elan linki, başlıq
// (turbo.az: "... qiyməti 240 000 AZN", tap.az: "...: 850 AZN — Bakı") və səhifə
// mətni (şəkil linkləri ilə). Server səhifəni özü aça bilmədiyi üçün qiymət
// İNDEKSDƏNDİR — saytdakı cari qiymətdən fərqlənə bilər; nəticədə bu
// `priceFromIndex: true` ilə işarələnir və kartda istifadəçiyə deyilir.

import type { WebResult } from './webSearchAI';
import { queryTokens, matchesQuery, type CarQuery } from './shopScrapers';

const TAVILY_URL = 'https://api.tavily.com/search';

interface TavilyRow { url: string; title?: string; content?: string; raw_content?: string | null }

async function tavily(query: string, domains: string[], maxResults = 20): Promise<TavilyRow[] | { error: string }> {
  try {
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_domains: domains,
        include_raw_content: 'markdown',   // şəkil linki və qiymət üçün (kredit dəyişmir)
        include_answer: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('[tavilyListings] HTTP', resp.status, t.slice(0, 200));
      return { error: resp.status === 401 || resp.status === 403 ? 'Axtarış açarı etibarsızdır.'
        : resp.status === 429 ? 'Axtarış limiti doldu, bir azdan yenidən cəhd edin.'
        : 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
    }
    const j: any = await resp.json();
    return Array.isArray(j?.results) ? j.results : [];
  } catch (e: any) {
    console.error('[tavilyListings] xəta:', e?.name, e?.message);
    return { error: 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
  }
}

// ── Başlıq / qiymət / şəkil ─────────────────────────────────────────────────
const NUM = String.raw`\d{1,3}(?:[  .,]\d{3})+|\d+(?:[.,]\d{1,2})?`;
function parseNum(s: string): number | null {
  let t = s.replace(/[\s ]/g, '');
  // "3,120" / "12.500" / "1,250,000" — minlik ayırıcı; "1799.99" / "12,5" — onluq.
  t = /^\d{1,3}([.,]\d{3})+$/.test(t) ? t.replace(/[.,]/g, '') : t.replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function curOf(sym: string): string {
  const s = sym.toUpperCase();
  if (s === '$' || s === 'USD') return 'USD';
  if (s === '€' || s === 'EUR') return 'EUR';
  return 'AZN';
}

// Qiymət əvvəlcə BAŞLIQDAN (sayt özü yazır), sonra mətnin ilk sətrindən.
// Mətnin qalanında başqa elanların qiymətləri və "bərpa - 30 AZN" kimi xidmət
// qiymətləri olur — onlara toxunmuruq.
function extractPrice(title: string, content: string): { price: number | null; currency: string } {
  const sources = [title, (content || '').split('\n').find((l) => l.trim()) || ''];
  for (const src of sources) {
    const m = src.match(new RegExp(`(?:qiym[əe]ti|цена|:)\\s*(${NUM})\\s*(AZN|₼|\\$|USD|€|EUR)`, 'i'))
      || (src === sources[1] ? src.match(new RegExp(`^\\s*(${NUM})\\s*(AZN|₼|\\$|USD|€|EUR)\\s*$`, 'i')) : null);
    if (m) {
      const price = parseNum(m[1]);
      if (price != null) return { price, currency: curOf(m[2]) };
    }
  }
  return { price: null, currency: 'AZN' };
}

// "BMW X5, 3.0 L, 2026 il, yeni Bakı almaq - qiyməti 240 000 AZN - Turbo.Az" → "BMW X5, 3.0 L, 2026 il, yeni"
// '"BMW X5 G05" air kit: 850 AZN — Bakı, Azərbaycan - Tap.Az' → '"BMW X5 G05" air kit'
function cleanTitle(t: string): string {
  return t
    .replace(/\s*-\s*(Turbo\.Az|Tap\.Az|lalafo\.az|Lalafo)\s*$/i, '')
    .replace(/\s+(Bakı|Baku|Sumqayıt|Gəncə|[A-ZÇƏĞİÖŞÜ][a-zçəğıöşü]+)\s+almaq\s*-\s*qiym[əe]ti.*$/i, '')
    .replace(/\s*-\s*qiym[əe]ti.*$/i, '')
    .replace(new RegExp(`:\\s*(?:${NUM})\\s*(?:AZN|₼|\\$|USD|€|EUR).*$`, 'i'), '')
    .replace(/\s*—\s*[^—]*$/, '')
    .trim()
    .slice(0, 160);
}

// Elanın əsas şəkli səhifə mətnindəki ilk böyük şəkil linkidir (saytın CDN-i).
function extractImage(raw: string): string | null {
  if (!raw) return null;
  const all = raw.match(/https?:\/\/[^\s)"'<>\]]+?(?:azstatic\.com|lalafo\.com)\/[^\s)"'<>\]]+?\.(?:jpe?g|png|webp)/gi) || [];
  const big = all.find((u) => /\/(full|f660x496|f460x34\d|original|posters)\//i.test(u));
  return big || all[0] || null;
}

function siteOf(url: string): string {
  try { return new URL(url).hostname.replace(/^(www|ru|en)\./, ''); } catch { return ''; }
}

function toResult(r: TavilyRow, category: string | null): WebResult {
  const title = cleanTitle(String(r.title || r.url));
  const { price, currency } = extractPrice(String(r.title || ''), String(r.content || ''));
  return {
    title,
    url: r.url.replace(/^https?:\/\/(ru|en)\./, 'https://'),   // AZ versiyası
    snippet: '',
    price,
    currency,
    site: siteOf(r.url),
    kind: 'product',
    category,
    image: extractImage(String(r.raw_content || '')),
    seller: null,
    priceFromIndex: true,
  };
}

function dedupe(items: WebResult[]): WebResult[] {
  const seen = new Set<string>();
  return items.filter((r) => {
    const k = r.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Canlı yoxlama: Tavily Extract ───────────────────────────────────────────
// İndeksdə köhnə, SATIŞDAN ÇIXARILMIŞ elanlar da olur (yoxlanılıb: turbo.az-da
// bir çox BMW X5 linki "Satışdan çıxarılıb" idi). Ona görə hər namizədi Tavily
// Extract ilə CANLI açırıq: aktiv deyilsə atılır, qiymət və şəkil səhifənin
// özündən götürülür. 'advanced' rejim lazımdır — 'basic' tap.az/lalafo/kontakt
// və bəzi turbo.az səhifələrini açmır. Kredit: 5 link → 2 kredit.
interface LivePage { active: boolean; title: string | null; price: number | null; currency: string; image: string | null }

// Satılmış / silinmiş elan göstəriciləri. DİQQƏT: "Bu elan silinəcək" və "bərpası"
// turbo.az-ın AKTİV elanlarında da gizli pəncərədə olur — onlar göstərici deyil.
const INACTIVE = /Satışdan çıxarılıb|satışdan çıxarılmışdır|Elan silinib|Elan deaktiv|Bu elan artıq aktiv deyil|Объявление (удалено|снято)|Elan tapılmadı|Stokda yoxdur|Mövcud deyil/i;

function livePrice(raw: string, url: string): { price: number | null; currency: string } {
  let text = raw.replace(/~~[^~\n]*~~/g, '');                 // üstündən xətt çəkilmiş köhnə qiymət
  // turbo.az: əsas qiymət "№ <id>" sətrindən ƏVVƏLdir; sonra oxşar elanların qiymətləri gəlir.
  if (/turbo\.az/.test(url)) {
    const cut = text.search(/\n\s*\*?\s*№\s*\d/);
    if (cut > 0) text = text.slice(0, cut);
  }
  // Şəkil sətirləri (qalereya 40+ sətir ola bilər) pəncərəni doldurmasın.
  const lines = text.split('\n').filter((l) => l.trim() && !/^\s*\[?!\[/.test(l));
  // Əsas qiymət başlığa ("# ...") yaxındır; aşağıda oxşar məhsulların qiymətləri olur.
  // turbo.az-da artıq "№" sətrində kəsilib — pəncərə lazım deyil.
  const ti = lines.findIndex((l) => /^#\s/.test(l));
  const win = ti >= 0 && !/turbo\.az/.test(url) ? lines.slice(Math.max(0, ti - 25), ti + 40) : lines;
  const CUR = '(AZN|₼|\\$|USD|€|EUR)(?![A-Za-z])';
  // 1) Qalın yazılmış qiymət (mağazalarda əsas qiymət belədir: **1799.99 ₼**).
  const bold = win.join('\n').match(new RegExp(`\\*\\*\\s*(${NUM})\\s*${CUR}\\s*\\*\\*`, 'i'));
  if (bold) {
    const price = parseNum(bold[1]);
    if (price != null) return { price, currency: curOf(bold[2]) };
  }
  // 2) Qiymətlə BAŞLAYAN ilk sətir (taksit / ilkin ödəniş / bərpa sətirləri xaric).
  const re = new RegExp(`^\\s*\\[?\\s*(${NUM})\\s*${CUR}`, 'i');
  for (const line of win) {
    if (/bərpa|-dən\b|dən$|aylıq|ayda|\/ay\b|\bx\s*\d+|\d+\s*ay\b|taksit|installment|cash purchase|ilkin|month|kredit|hissə-hissə|nisyə/i.test(line)) continue;
    const m = line.match(re);
    if (m) {
      const price = parseNum(m[1]);
      if (price != null) return { price, currency: curOf(m[2]) };
    }
  }
  return { price: null, currency: 'AZN' };
}

function liveImage(images: string[], raw: string): string | null {
  const good = (u: string) => /^https?:\/\//.test(u) && !/countdown|banner|logo|icon|favicon|sprite|placeholder|avatar|\.svg/i.test(u);
  const list = (images || []).filter(good);
  const big = list.find((u) => /\/(full|f660x496|original|posters|large|product)/i.test(u));
  return big || list[0] || extractImage(raw);
}

interface RawPage { raw: string; images: string[] }

// Tavily Extract — səhifələrin canlı mətni (markdown) və şəkilləri.
async function extractRaw(urls: string[]): Promise<Map<string, RawPage>> {
  const out = new Map<string, RawPage>();
  if (!urls.length) return out;
  try {
    const resp = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ urls, extract_depth: 'advanced', format: 'markdown', include_images: true }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      console.error('[tavilyListings] extract HTTP', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
      return out;
    }
    const j: any = await resp.json();
    for (const x of (Array.isArray(j?.results) ? j.results : [])) {
      const raw = String(x?.raw_content || '');
      if (!x?.url || !raw) continue;
      out.set(x.url, { raw, images: Array.isArray(x.images) ? x.images : [] });
    }
  } catch (e: any) {
    console.error('[tavilyListings] extract xəta:', e?.name, e?.message);
  }
  return out;
}

async function extractLive(urls: string[]): Promise<Map<string, LivePage>> {
  const pages = await extractRaw(urls);
  const out = new Map<string, LivePage>();
  for (const [url, { raw, images }] of pages) {
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
    out.set(url, {
      active: !INACTIVE.test(raw),
      title: title ? title.slice(0, 160) : null,
      ...livePrice(raw, url),
      image: liveImage(images, raw),
    });
  }
  console.log('[tavilyListings] extract:', urls.length, '| açılan:', out.size, '| aktiv:', [...out.values()].filter((p) => p.active).length);
  return out;
}

// ── Kateqoriya səhifələrindən məhsul kartları ───────────────────────────────
// Ümumi adla axtarışda ("soyuducu", "paltaryuyan") Tavily əsasən mağazaların
// KATEQORİYA səhifələrini qaytarır. Onları canlı açıb içindəki məhsul kartlarını
// götürürük. Kart markdown-da belədir:
//   [![Image 23: Soyuducu Hitachi R-W660...](şəkil) - 790 ₼ ... #### Soyuducu Hitachi R-W660...
//    3599.99 ₼2809.99 ₼ 18 ay 156.11 ₼ Səbətə at](https://bakuelectronics.az/mehsul/...)
// Qiymət: endirim ("- 790 ₼") və aylıq taksit ("18 ay 156.11 ₼") xaric, qalanların
// ən kiçiyi (köhnə qiymət həmişə yenisindən böyükdür).
function cardPrice(text: string): { price: number | null; currency: string } {
  const t = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/~~[^~]*~~/g, ' ');
  // Valyuta: ₼ / AZN / "M" / "man" (soliton.az "289.99 M") / $ / €.
  const re = new RegExp(`(${NUM})\\s*(₼|AZN|man\\b|M\\b|\\$|USD|€|EUR)`, 'g');
  const vals: { v: number; cur: string }[] = [];
  for (const m of t.matchAll(re)) {
    const idx = m.index || 0;
    const before = t.slice(Math.max(0, idx - 14), idx);
    const after = t.slice(idx + m[0].length, idx + m[0].length + 24);
    if (/[-−–]\s*$/.test(before)) continue;                                   // endirim məbləği ("- 790 ₼")
    if (/(\d+\s*(ay|month)|aylıq|ayda|\bx)\s*\**\s*$/i.test(before) || /^\s*(\/\s*ay|x\s*\d)/i.test(after)) continue;  // taksit
    if (/^\s*(cash purchase|nağd|naghd|discount|endirim|ilkin|bonus)/i.test(after)) continue;          // nağd endirim / ilkin ödəniş
    if (/qənaət|endirim|bonus|keşbek|cashback|%/i.test(before)) continue;
    const v = parseNum(m[1]);
    if (v != null) vals.push({ v, cur: /^(M|man)$/i.test(m[2]) ? 'AZN' : curOf(m[2]) });
    if (vals.length >= 2) break;                                               // yeni + köhnə qiymət
  }
  if (!vals.length) return { price: null, currency: 'AZN' };
  const best = vals.reduce((a, b) => (b.v < a.v ? b : a));                    // köhnə qiymət həmişə böyükdür
  return { price: best.v, currency: best.cur };
}

function absUrl(u: string, base: string): string | null {
  try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; }
}

// Kateqoriya səhifəsindəki məhsul kartları. Saytlarda iki düzülüş var:
//  (a) bütün kart linkin içindədir: [![ad](şəkil) ... #### Ad 3599 ₼2809 ₼ 18 ay 156 ₼](/mehsul/...)
//  (b) şəkil-link, sonra ad və qiymət ayrıca: [![ad](şəkil)](/m/...) ... 289.99 M479.99 M
// Hər iki halda kart = məhsulun ilk linkinin başlanğıcından NÖVBƏTİ məhsulunkuna qədər.
export function harvestCards(raw: string, pageUrl: string, tokens: string[], limit = 6): WebResult[] {
  const site = siteOf(pageUrl);
  const first = new Map<string, number>();
  for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
    const url = absUrl(m[1], pageUrl);
    if (!url || siteOf(url) !== site || !isListingUrl(url) || url.replace(/[?#].*$/, '') === pageUrl.replace(/[?#].*$/, '')) continue;
    if (/\.(jpe?g|png|webp|gif|svg)(\?|$)|\/(wp-content|uploads|media|images|static)\//i.test(url)) continue;   // şəkil faylı
    if (!first.has(url)) first.set(url, m.index || 0);
  }
  const cards = [...first.entries()].map(([url, at]) => {
    const img = raw.lastIndexOf('[![', at);
    return { url, start: img >= 0 && at - img < 2500 ? img : raw.lastIndexOf('[', at) };
  }).sort((x, y) => x.start - y.start);

  const out: WebResult[] = [];
  for (let i = 0; i < cards.length && out.length < limit; i++) {
    const { url, start } = cards[i];
    const end = Math.min(i + 1 < cards.length ? cards[i + 1].start : raw.length, start + 3000);
    const text = raw.slice(start, end);
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkText = [...text.matchAll(/\[([^\]!\[][^\]]{3,})\]\(([^)\s]+)\)/g)]
      .find((m) => absUrl(m[2], pageUrl) === url)?.[1];
    // Başlıq "### [Ad](link)" formasındadırsa, link MƏHZ bu məhsula aparmalıdır —
    // əks halda kart sərhədi qarışıb (başqa məhsulun adı/qiyməti), kartı atırıq.
    const hm = text.match(/#{2,6}\s*([^#\n]+?)\s*(?:\n|$)/)?.[1] || '';
    const hl = hm.match(/^\[([^\]]+)\]\(([^)\s]+)/);
    if (hl && absUrl(hl[2], pageUrl)?.replace(/\/+$/, '') !== url.replace(/\/+$/, '')) continue;
    const heading = hl ? hl[1] : hm;
    const alt = text.match(/!\[(?!Image\s*\d+\s*\])(?:Image\s*\d+\s*:\s*)?([^\]]{4,})\]/)?.[1];
    void esc;
    const name = (linkText || heading || alt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    // Ad sorğunu daşımalıdır VƏ YA məhsul həmin kateqoriyanın öz bölməsindədir
    // (soliton: ".../soyuducular/2026...-riffel-rtt-14716" — adda "soyuducu" yoxdur).
    const pagePath = (() => { try { return new URL(pageUrl).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
    const inCategory = pagePath.length > 3 && new URL(url).pathname.startsWith(pagePath + '/');
    if (!name || /\?$|nələrə|necə |seçərkən|məsləhət/i.test(name)) continue;          // məqalə kartları
    if (!matchesQuery(name, tokens) && !inCategory) continue;
    const { price, currency } = cardPrice(text);
    if (price == null) continue;
    const imgUrl = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).find((u) => !u.startsWith('data:'));
    out.push({
      title: name,
      url,
      snippet: '',
      price,
      currency,
      site,
      kind: 'product',
      category: null,
      image: imgUrl ? absUrl(imgUrl, pageUrl) : null,
      seller: null,
      priceFromIndex: false,      // kateqoriya səhifəsi indicə canlı açılıb
    });
  }
  return out;
}

async function categoryCards(pages: string[], tokens: string[]): Promise<WebResult[]> {
  const raw = await extractRaw(pages);
  const lists = pages.map((u) => {
    const p = raw.get(u);
    return p ? harvestCards(p.raw, u, tokens) : [];
  });
  console.log('[tavilyListings] kateqoriya səhifələri:', pages.length, '| açılan:', raw.size, '| kart:', lists.map((l) => l.length).join('/'));
  // Səhifələr arasında növbə ilə — bir mağaza bütün nəticələri tutmasın.
  const out: WebResult[] = [];
  for (let i = 0; i < 6; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

// Namizədləri canlı yoxla: aktiv elanlar canlı qiymət/şəkillə (priceFromIndex=false),
// satışdan çıxarılmışlar atılır. Açıla bilməyənlər yalnız aktiv nəticə AZ olanda
// indeks məlumatı ilə saxlanılır (kartda "qiymət saytda dəyişə bilər").
async function verifyLive(items: WebResult[], min = 5): Promise<WebResult[]> {
  const live = await extractLive(items.map((r) => r.url));
  const ok: WebResult[] = [];
  const unknown: WebResult[] = [];
  for (const r of items) {
    const p = live.get(r.url);
    if (!p) { unknown.push(r); continue; }
    if (!p.active) continue;                                   // satılıb / silinib
    ok.push({
      ...r,
      title: p.title && p.title.length > 3 ? p.title : r.title,
      price: p.price ?? r.price,
      currency: p.price != null ? p.currency : r.currency,
      image: p.image || r.image,
      priceFromIndex: p.price == null,
    });
  }
  return ok.length >= min ? ok : [...ok, ...unknown.slice(0, min - ok.length)];
}

// ── Maşın ───────────────────────────────────────────────────────────────────
// Yalnız konkret maşın elanları: turbo.az/autos/<id>-<slug> və tap.az-ın
// "Avtomobillər" bölməsi. Model dəqiq olmalıdır: "bmw x5" → "BMW X5 M" yox
// (turbo.az linkinin slug-ı ilə yoxlanılır).
export async function tavilyCarListings(car: CarQuery): Promise<{ results: WebResult[]; error?: string }> {
  const name = car.classLetter
    ? `${car.makeName} ${car.classLetter.toUpperCase()}-Class`
    : `${car.makeName} ${car.modelIds.length === 1 ? car.modelName || '' : ''}`.trim();
  const rows = await tavily(`${name} satılır`, ['turbo.az', 'tap.az'], 20);
  if (!Array.isArray(rows)) return { results: [], error: rows.error };

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const wantSlug = car.classLetter ? null : slug(name);
  const makeTokens = queryTokens(car.makeName);
  const out: WebResult[] = [];
  for (const r of rows) {
    if (!r?.url) continue;
    const turbo = r.url.match(/^https?:\/\/(?:www\.)?turbo\.az\/autos\/\d+-([a-z0-9-]+)/i);
    const tapCar = /^https?:\/\/(?:www\.)?tap\.az\/elanlar\/neqliyyat\/avtomobiller\/\d+/i.test(r.url);
    if (!turbo && !tapCar) continue;
    const res = toResult(r, tapCar ? 'neqliyyat/avtomobiller' : 'turbo.az/autos');
    if (turbo) {
      if (wantSlug && turbo[1] !== wantSlug) continue;                    // "bmw-x5-m" ≠ "bmw-x5"
      if (car.classLetter && !new RegExp(`-${car.classLetter}-?\\d{2,3}`, 'i').test(turbo[1])) continue;
    } else {
      if (!matchesQuery(res.title, makeTokens)) continue;
      if (car.classLetter ? !new RegExp(`\\b${car.classLetter}[ -]?\\d{2,3}\\b`, 'i').test(res.title)
        : car.modelName && !matchesQuery(res.title.split(',')[0], queryTokens(name))) continue;
    }
    out.push(res);
  }
  console.log('[tavilyListings] maşın:', name, '| xam:', rows.length, '| elan:', out.length);
  // turbo.az birinci (maşın üçün əsas sayt), ən çox 12 namizəd canlı yoxlanılır.
  const cands = dedupe(out).sort((a, b) => (a.site === 'turbo.az' ? 0 : 1) - (b.site === 'turbo.az' ? 0 : 1)).slice(0, 15);
  return { results: await verifyLive(cands) };
}

// ── Digər məhsullar ─────────────────────────────────────────────────────────
// AZ elan/mağaza saytları; yalnız konkret elan/məhsul linkləri (kateqoriya,
// axtarış, ana səhifə yox). tap.az-da kateqoriya linkin özündədir.
const SHOP_DOMAINS = [
  'tap.az', 'lalafo.az', 'umico.az', 'birmarket.az', 'kontakt.az', 'irshad.az',
  'bakuelectronics.az', 'soliton.az', 'texnomart.az', 'optimal.az', 'trendyol.az',
];

function isListingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|ru|en)\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    if (u.search && /[?&](q|query|keywords|q%5B|p%5B)/i.test(u.search)) return false;
    // Dil versiyaları (eyni məhsulun rus/ingilis səhifəsi) — təkrar olmasın.
    if (/^(ru|en)\./.test(u.hostname) || /^\/(ru|en)(\/|$)/.test(u.pathname) || /-(ru|en)$/.test(path)) return false;
    if (/\/(tags?|teq|etiket)\/|qiymetleri|qiymeti|qiymet(\/|$)|\/compare|\/(blog|xeberler|xeber|news|novosti|icmal|mehsul-icmali|meqale|meqaleler|articles?|review)\//i.test(path + '/')) return false;
    if (host === 'tap.az') return /^\/elanlar\/[^/]+\/[^/]+\/\d+$/.test(path);
    if (host === 'lalafo.az') return /\/ads\/.+-id-\d+$/.test(path);
    if (host === 'turbo.az') return /^\/autos\/\d+/.test(path);
    // Mağazalar: rəqəmsal ID və ya uzun slug (məhsul səhifəsi).
    if (!path || /\/(search|axtaris|catalogsearch|category|categories|brand|brands|kateqoriya)(\/|$)/i.test(path)) return false;
    // Mağaza məhsul səhifəsi: son seqment ən azı 4 hissəli slug ("iphone-15-128-gb-blue");
    // "apple-iphone-15" kimi qısa sluglar adətən model/kateqoriya səhifəsidir.
    const last = path.split('/').filter(Boolean).pop() || '';
    return last.split('-').length >= 4 || /\d{5,}/.test(last);
  } catch { return false; }
}

export async function tavilyProductListings(q: string): Promise<{ results: WebResult[]; error?: string }> {
  // İki paralel axtarış: elan saytları (tap.az, lalafo.az) və mağazalar — əks halda
  // mağaza səhifələri elanları sıxışdırıb çıxarır.
  const [ads, shops] = await Promise.all([
    tavily(q, ['tap.az', 'lalafo.az'], 15),
    tavily(q, SHOP_DOMAINS.filter((d) => d !== 'tap.az' && d !== 'lalafo.az'), 15),
  ]);
  if (!Array.isArray(ads) && !Array.isArray(shops)) return { results: [], error: ads.error };
  // Növbə ilə birləşdir: elan, mağaza, elan, mağaza ...
  const a = Array.isArray(ads) ? ads : [], b = Array.isArray(shops) ? shops : [];
  const rows: TavilyRow[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) rows.push(a[i]); if (b[i]) rows.push(b[i]); }
  const tokens = queryTokens(q);
  const out: WebResult[] = [];
  const catPages: string[] = [];
  for (const r of rows) {
    if (!r?.url) continue;
    if (!isListingUrl(r.url)) {
      // Mağazanın kateqoriya/brend səhifəsi — içindəki kartlar üçün (tap/lalafo-nunkular açılmır).
      const site = siteOf(r.url);
      if (!['tap.az', 'lalafo.az', 'turbo.az'].includes(site) && !/\/(blog|bloq|xeber|news|pages|aksiya|kampaniya)/i.test(r.url)
        && !/^https?:\/\/(ru|en)\.|\/(ru|en)\//.test(r.url)
        && (matchesQuery(String(r.title || ''), tokens) || matchesQuery(decodeURIComponent(r.url).replace(/[-_/]+/g, ' '), tokens))
        && !catPages.some((u) => siteOf(u) === site) && catPages.length < 4) catPages.push(r.url);
      continue;
    }
    const site = siteOf(r.url);
    const category = site === 'tap.az' ? new URL(r.url).pathname.split('/').slice(2, 4).join('/') : null;
    const res = toResult(r, category);
    if (!matchesQuery(res.title, tokens)) continue;
    // Mağaza saytlarında (tap/lalafo xaric) məhsul linkinin slug-ı da sorğunu daşımalıdır
    // ("soyuducu-samsung-rb29..." ✓, kateqoriya ".../stasionar/soyuducu" ✗).
    if (!['tap.az', 'lalafo.az', 'turbo.az'].includes(site)) {
      const last = decodeURIComponent(new URL(res.url).pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ');
      if (!matchesQuery(last, tokens)) continue;
    }
    out.push(res);
  }
  console.log('[tavilyListings] məhsul:', q, '| xam:', rows.length, '| elan:', out.length, '| kateqoriya:', catPages.length);
  // Elan linkləri canlı yoxlanılır; paralel olaraq kateqoriya səhifələrindən kartlar.
  const [listings, cards] = await Promise.all([
    out.length ? verifyLive(dedupe(out).slice(0, 15)) : Promise.resolve([] as WebResult[]),
    catPages.length ? categoryCards(catPages, tokens) : Promise.resolve([] as WebResult[]),
  ]);
  // Canlı yoxlanılmış ayrı elanlar əvvəl, sonra kateqoriya kartları, sonda indeks.
  const liveFirst = [...listings.filter((r) => !r.priceFromIndex), ...cards, ...listings.filter((r) => r.priceFromIndex)];
  const tidy = liveFirst
    // Başlığa yapışan qiymət mətni: "Robot tozsoran Xiaomi H50 1999.99 ₼" → "... H50"
    .map((r) => ({ ...r, title: r.title.replace(new RegExp(`\\s*(${NUM})\\s*(₼|AZN|M)(\\s|$).*$`), '').trim() || r.title }))
    // Kateqoriya adları ("TV, audio və video"): rəqəmsiz + "və" — məhsul deyil.
    .filter((r) => !(/(^|\s)v[əe](\s|$)/i.test(r.title) && !/\d/.test(r.title)));
  return { results: dedupe(tidy) };
}
