// Azərbaycan alış-veriş saytlarında BİRBAŞA axtarış (internet axtarışının əsas mənbəyi).
//
// Niyə: Tavily kimi axtarış motorları çox vaxt kateqoriya / ana səhifə linki
// qaytarır, qiyməti isə köhnə indeks snippet-indən götürür — nəticədə link ana
// səhifəyə atır və göstərilən qiymət saytdakından fərqlənirdi. Burada isə həmin
// saytların ÖZ axtarış səhifəsini oxuyuruq: hər nəticə konkret elanın linkidir,
// qiymət və şəkil saytın öz məlumatından (canlı) gəlir — elana daxil olanda
// görünən qiymətlə eynidir (empirik yoxlanılıb: tap.az, lalafo.az).
//
// Hər mənbə müstəqildir: biri xəta versə / dəyişsə, digərləri işləməyə davam edir.
// Alınmayan mənbə sadəcə boş massiv qaytarır — axtarış pozulmur.

import type { WebResult } from './webSearchAI';
// turbo.az marka/model kataloqunun layihədəki surəti — prod server turbo.az-a
// çata bilməsə də maşın sorğuları ("bmw x5") tanınsın.
import bundledTurboCatalog from '../data/turboCatalog.json';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 9000;
const MAX_HTML = 2_500_000;

async function getHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'az,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, MAX_HTML);
    return { html, finalUrl: res.url || url };
  } catch (e: any) {
    console.error('[shopScrapers]', url.slice(0, 70), e?.name || e?.message);
    return null;
  }
}

function nextData(html: string): any | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// ── Uyğunluq filtri ─────────────────────────────────────────────────────────
// Saytların axtarışı (xüsusən VIP/reklam elanları) sorğuya aid olmayan elan da
// qaytarır. Sorğunun BÜTÜN sözləri başlıqda olmalıdır ("iphone 15" → "iPhone 15
// Pro" keçir, "iPhone 16" və "Telefon təmiri" keçmir). Rəqəmlər tam söz kimi
// yoxlanılır ki, "15" → "150" ilə uyğun gəlməsin.
function fold(s: string): string {
  return s.toLowerCase().replace(/\+/g, ' plus ')
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/[^a-z0-9а-яё]+/g, ' ').trim();
}
// Sadə kök çıxarma — ən çox işlənən hal/mənsubiyyət/cəm şəkilçiləri (fold-dan sonra
// ə→e, ı→i, ü→u, ö→o olduğundan qısa siyahı kifayətdir).
const AZ_SUFFIXES = ['larinin', 'lerinin', 'lari', 'leri', 'larin', 'lerin', 'nin', 'nun', 'sini', 'sunu', 'si', 'su', 'lar', 'ler', 'ni', 'nu', 'da', 'de', 'dan', 'den', 'i', 'u'];
function azStem(w: string): string {
  if (/\d/.test(w) || w.length < 4) return w;
  for (const suf of AZ_SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}
// Məhsul növü sinonimləri — elan sahibləri eyni şeyi müxtəlif sözlə yazır
// ("iphone 15 qabı" ↔ "iPhone 15 kabro / case / arxalıq"). Hər qrupun BİRİNCİ sözü
// saytlarda əlavə axtarış variantı kimi işlədilir.
const SYNONYM_GROUPS: string[][] = [
  ['kabro', 'qab', 'case', 'cexol', 'chexol', 'arxaliq', 'ortuk', 'cover', 'qoruyucu', 'chehol', 'cehol'],
  ['telefon', 'smartfon', 'phone', 'mobil'],
  ['noutbuk', 'notebook', 'laptop', 'macbook'],
  ['qulaqciq', 'qulaqliq', 'naushnik', 'headphone', 'headphones', 'earbuds', 'qulaqcig'],
  ['soyuducu', 'xolodilnik', 'refrigerator', 'holodilnik'],
  ['paltaryuyan', 'stiralka', 'washing'],
  ['televizor', 'tv', 'televiziya', 'smart tv'],
  ['velosiped', 'bike', 'bicycle', 'velo'],
  ['planset', 'tablet'],
  ['canta', 'sumka', 'bag'],
  ['ayaqqabi', 'krossovka', 'krossovki', 'sneaker', 'sneakers', 'tufli'],
  ['kondisioner', 'kondey', 'split', 'kondisoner'],
  ['tozsoran', 'pylesos', 'tozsorani'],
  ['saat', 'watch'],
  ['divan', 'sofa'],
  ['sarj', 'sarjer', 'charger', 'adapter', 'zaryadka'],
  ['ekran', 'displey', 'display', 'ekrani'],
  ['qoruyucu sushe', 'sushe', 'suse', 'steklo', 'glass'],
  ['kreslo', 'oturacaq'],
  ['masin', 'avtomobil', 'avto'],
];
const SYNONYM_OF = new Map<string, string[]>();
for (const g of SYNONYM_GROUPS) for (const w of g) SYNONYM_OF.set(w, g);
function synonymsOf(t: string): string[] | null {
  return SYNONYM_OF.get(t) || SYNONYM_OF.get(azStem(t)) || null;
}

export function queryTokens(q: string): string[] {
  return fold(q).split(' ').filter((t) => t.length >= 1);
}
export function matchesQuery(title: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const words = fold(title).split(' ');
  const joined = ' ' + words.join(' ') + ' ';
  const glued = words.join('');               // "iphone15" yazılışı üçün
  return tokens.every((t, i) => {
    // Rəqəm: ayrıca söz ("iphone 15") və ya əvvəlki sorğu sözünə bitişik ("iphone15").
    // "playstation 5" → "PS5" ilə UYĞUN GƏLMİR (əvvəl balans/oyun elanları keçirdi).
    if (/^\d+$/.test(t)) return words.includes(t) || (i > 0 && new RegExp(`${tokens[i - 1]}${t}(?!\\d)`).test(glued));
    // Söz başlanğıcı ilə uyğunluq ("samsung" → "samsung", "galax" → "galaxy").
    if (joined.includes(' ' + t) || (t.length >= 4 && glued.includes(t))) return true;
    // Sinonim: "qab" sorğusu "kabro/case/arxalıq" yazılmış elanı da tapır.
    const syn = synonymsOf(t);
    if (syn && words.some((w) => syn.includes(w) || syn.includes(azStem(w)) || syn.some((x) => x.length >= 4 && w.startsWith(x)))) return true;
    // Azərbaycan şəkilçiləri: "qabı" ↔ "qab", "saatları" ↔ "saat", "telefonu" ↔ "telefon".
    const stem = azStem(t);
    return stem !== t && stem.length >= 3 && words.some((w) => azStem(w) === stem || w.startsWith(stem));
  });
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normCurrency(c: unknown): string {
  const s = String(c || '').trim().toUpperCase();
  if (!s || s === '₼' || s === 'AZN' || s === 'MANAT' || s === 'MAN') return 'AZN';
  if (s === '$' || s === 'USD') return 'USD';
  if (s === '€' || s === 'EUR') return 'EUR';
  if (s === '₽' || s === 'RUB') return 'RUB';
  return s.slice(0, 5);
}

// ── tap.az ──────────────────────────────────────────────────────────────────
// Axtarış səhifəsi SSR-dir; elanlar __NEXT_DATA__ → apolloState-dədir.
// Açar parametr `q[keywords]` (sadə `keywords` server tərəfdə nəzərə alınmır).
async function searchTapAz(q: string, tokens: string[], section = 'elanlar'): Promise<WebResult[]> {
  const page = await getHtml(`https://tap.az/${section}?q%5Bkeywords%5D=${encodeURIComponent(q)}`);
  if (!page) return [];
  const ap = nextData(page.html)?.props?.pageProps?.apolloState;
  if (!ap || typeof ap !== 'object') return [];
  const out: WebResult[] = [];
  for (const [k, a] of Object.entries<any>(ap)) {
    if (!k.startsWith('Ad:') || !a || a.status !== 'APPROVED') continue;
    if (typeof a.path !== 'string' || !/\/\d+$/.test(a.path)) continue;  // yalnız konkret elan
    const title = String(a.title || '').trim();
    if (!title || !matchesQuery(title, tokens)) continue;
    const img = a['photo({"source":"DESKTOP"})']?.url || a.photo?.url || null;
    out.push({
      title: title.slice(0, 160),
      url: `https://tap.az${a.path}`,
      snippet: [a.region].filter(Boolean).join(' · '),
      price: toNum(a.price),
      currency: 'AZN',            // tap.az qiymətləri həmişə AZN-dədir
      site: 'tap.az',
      // Kateqoriya linkin özündədir: /elanlar/<bölmə>/<alt-bölmə>/<id>
      category: a.path.split('/').slice(2, 4).join('/'),
      kind: 'product',
      image: img,
      seller: null,
    });
  }
  return out;
}

// lalafo elanında yalnız category_id var — adları kateqoriya ağacından (açıq API)
// götürürük: 8178 → "Nəqliyyat > Aksesuarlar və tüninq > ... > Sürət qutusunun başlıqları".
// Ağac ~2 MB-dır, 24 saat keşlənir.
let lalafoCats: { map: Map<number, string>; at: number } | null = null;
let lalafoCatsLoading: Promise<Map<number, string>> | null = null;
async function loadLalafoCategories(): Promise<Map<number, string>> {
  if (lalafoCats && Date.now() - lalafoCats.at < 24 * 3600 * 1000) return lalafoCats.map;
  if (lalafoCatsLoading) return lalafoCatsLoading;
  lalafoCatsLoading = (async () => {
    try {
      const res = await fetch('https://lalafo.az/api/catalog/v3/categories/tree?with_duplicates=1&expand=url', {
        headers: { 'user-agent': BROWSER_UA, 'country-id': '13', device: 'pc', language: 'az_AZ', accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return lalafoCats?.map || new Map();
      const tree = (await res.json()) as any[];
      const map = new Map<number, string>();
      const walk = (nodes: any[], path: string[]) => {
        for (const n of nodes || []) {
          if (!n || typeof n.name !== 'string') continue;
          const p = [...path, n.name];
          map.set(Number(n.id), p.join(' > '));
          if (Array.isArray(n.children)) walk(n.children, p);
        }
      };
      walk(Array.isArray(tree) ? tree : [], []);
      if (map.size) lalafoCats = { map, at: Date.now() };
      return map.size ? map : (lalafoCats?.map || new Map());
    } catch (e: any) {
      console.error('[shopScrapers] lalafo kateqoriyalar:', e?.name || e?.message);
      return lalafoCats?.map || new Map();
    }
  })().finally(() => { lalafoCatsLoading = null; });
  return lalafoCatsLoading;
}

// ── Kateqoriya süzgəci (bütün məhsullar üçün) ───────────────────────────────
// Axtarılan MƏHSULUN ÖZÜ lazımdır. Elan aşağıdakı "ikinci dərəcəli" kateqoriyalardadırsa
// (oyuncaq, ehtiyat hissə, aksesuar, xidmət/təmir/icarə, iş, tanışlıq) atılır —
// AMMA istifadəçi sorğuda bunu özü istəyibsə ("bmw x5 təkər", "iphone qabı",
// "oyuncaq maşın", "telefon təmiri") həmin qrup saxlanılır.
// Bu, ad siyahısından asılı deyil: hər məhsul üçün saytın öz kateqoriyası işləyir.
const CATEGORY_GROUPS: { name: string; cat: RegExp; intent: RegExp }[] = [
  { name: 'toy', cat: /oyuncaq|usaq-avtomobil|uşaq avtomobil|uşaq nəqliyyat|kolleksiya|maket|suvenir/i,
    intent: /oyuncaq|usaq|uşaq|maket|kolleksiya|model\b|suvenir|radio idar|pultlu/i },
  { name: 'part', cat: /ehtiya?t|hiss[əe]|aksess?uar|t[üu]ninq|tuning|komplektl|zapchast|ban, kuzov|şin|sin-ve-disk|təkər|teker|disk|ekran|batareya|korpus|qab|çexol|kabro/i,
    intent: /ehtiyat|hiss[əe]|aksesuar|t[üu]ninq|t[əe]k[əe]r|disk|şin|fara|bamper|ekran|batareya|korpus|qab|çexol|cexol|kabro|şüşə|suse|adapter|kabel|şarj|sarj|pult|joystick|filtr|yağ|akkumulyator|stop|güzgü|guzgu|kapot|qapı|qapi|radiator|diffuzor/i },
  { name: 'service', cat: /xidm[əe]t|xidmet|t[əe]mir|temir|icar[əe]|icare|kiray[əe]|kiraye|kurs|t[əe]lim|telim|usta|quraşdır/i,
    intent: /xidm[əe]t|t[əe]mir|temir|icar|kiray|kurs|t[əe]lim|usta|quraşd|ustas/i },
  { name: 'other', cat: /is-elanlari|iş elanları|vakansiya|tanisliq|tanışlıq|itmiş|heyvanlar|biznes üçün avadanl/i, intent: /^$/ },
];

// Kateqoriyanın HANSİ hissəsinə baxırıq: tap.az → alt-bölmə slugu; lalafo → ağacın
// səviyyələri, amma " və " ilə birləşən ümumi qrup adları ("Mobil telefon və
// aksesuarlar") nəzərə alınmır — əks halda telefonların özü də "aksesuar" sayılardı.
function categorySignal(r: WebResult): string {
  const c = r.category || '';
  if (!c) return '';
  if (r.site === 'tap.az') return c.split('/').slice(1).join('/');
  // "Şəxsi əşyalar > Aksesuarlar" — saat, çanta, zinət (məhsulun özüdür, hissə deyil).
  const cleaned = c.replace(/^Şəxsi əşyalar > Aksesuarlar( > )?/, 'Şəxsi əşyalar$1');
  return cleaned.split(' > ').filter((seg) => !/ v[əe] /i.test(seg)).join(' > ');
}

export function categoryGroup(r: WebResult): string | null {
  const sig = categorySignal(r);
  if (!sig) return null;
  for (const g of CATEGORY_GROUPS) if (g.cat.test(sig)) return g.name;
  return null;
}

export function filterByCategory(items: WebResult[], q: string): WebResult[] {
  const fq = q.toLowerCase();
  const allowed = new Set(CATEGORY_GROUPS.filter((g) => g.intent.test(fq)).map((g) => g.name));
  return items.filter((r) => {
    const g = categoryGroup(r);
    return !g || allowed.has(g);
  });
}

// ── lalafo.az ───────────────────────────────────────────────────────────────
// Axtarış: /azerbaijan/q-<sorğu>. Elanlar react-query dehydratedState-dədir.
// DİQQƏT: lalafo-da slug köhnə başlıqdan qala bilir — uyğunluğu yalnız
// başlıqla yoxlayırıq (slug-la yox).
async function searchLalafo(q: string, tokens: string[]): Promise<WebResult[]> {
  const slug = q.trim().toLowerCase().replace(/\s+/g, '-');
  const [page, cats] = await Promise.all([
    getHtml(`https://lalafo.az/azerbaijan/q-${encodeURIComponent(slug)}`),
    loadLalafoCategories(),
  ]);
  if (!page) return [];
  const queries: any[] = nextData(page.html)?.props?.pageProps?.dehydratedState?.queries || [];
  const feed = queries.find((x) => Array.isArray(x?.queryKey) && x.queryKey[0] === 'listingFeed');
  const items: any[] = (feed?.state?.data?.pages || []).flatMap((p: any) => (Array.isArray(p?.items) ? p.items : []));
  const out: WebResult[] = [];
  for (const it of items) {
    const title = String(it?.title || '').trim();
    if (!title || typeof it.url !== 'string' || !/-id-\d+$/.test(it.url)) continue;
    if (!matchesQuery(title, tokens)) continue;
    const img = Array.isArray(it.images) && it.images.length
      ? (it.images.find((i: any) => i?.is_main) || it.images[0])
      : null;
    out.push({
      title: title.slice(0, 160),
      url: `https://lalafo.az${it.url}`,
      snippet: [it.city].filter(Boolean).join(' · '),
      price: toNum(it.price),
      currency: normCurrency(it.currency || it.symbol),
      site: 'lalafo.az',
      category: cats.get(Number(it.category_id)) || null,
      kind: 'product',
      image: img?.thumbnail_url || img?.original_url || null,
      seller: it.user?.company_name || null,
    });
  }
  return out;
}

// ── turbo.az (avtomobil) ────────────────────────────────────────────────────
// turbo.az söz axtarışını (`q[keywords]`) NƏZƏRƏ ALMIR — ona görə marka/model
// ID-ləri ilə axtarırıq (Google-da "bmw x5" yazanda çıxan turbo.az səhifəsi kimi).
// Kataloq (marka + model ID-ləri) turbo.az-ın axtarış formasından oxunur və
// 24 saat keşlənir.
interface TurboCatalog { makes: { id: string; name: string; f: string }[]; models: { id: string; make: string; name: string; f: string }[]; at: number }
let turboCatalog: TurboCatalog | null = null;
let turboCatalogLoading: Promise<TurboCatalog | null> | null = null;
let turboCatalogFailedAt = 0;

function catalogFromBundle(): TurboCatalog {
  const b: any = bundledTurboCatalog;
  return {
    makes: (b.makes || []).map(([id, name]: [string, string]) => ({ id, name, f: fold(name) })),
    models: (b.models || []).map(([id, make, name]: [string, string, string]) => ({ id, make, name, f: fold(name) })),
    at: 0,   // canlı yükləmə uğurlu olanda əvəzlənsin
  };
}

async function loadTurboCatalog(): Promise<TurboCatalog | null> {
  if (turboCatalog && turboCatalog.at && Date.now() - turboCatalog.at < 24 * 3600 * 1000) return turboCatalog;
  // Canlı yükləmə uğursuz olubsa, 1 saatdan bir yenidən cəhd et; arada surət işləsin.
  if (turboCatalog && !turboCatalog.at && Date.now() - turboCatalogFailedAt < 3600 * 1000) return turboCatalog;
  if (turboCatalogLoading) return turboCatalogLoading;
  turboCatalogLoading = (async () => {
    const page = await getHtml('https://turbo.az/autos');
    if (!page) {
      // turbo.az əlçatan deyil (məs. server IP-si bloklanır) — layihədəki surət.
      console.warn('[shopScrapers] turbo.az kataloqu yüklənmədi — layihədəki surət işlədilir');
      turboCatalogFailedAt = Date.now();
      if (!turboCatalog) turboCatalog = catalogFromBundle();
      return turboCatalog;
    }
    const mk = page.html.match(/<select[^>]*name="q\[make\]\[\]"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
    const md = page.html.match(/<select[^>]*name="q\[model\]\[\]"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
    const makes = [...mk.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]+)</g)]
      .map((m) => { const name = decodeEntities(m[2]).trim(); return { id: m[1], name, f: fold(name) }; });
    const models = [...md.matchAll(/<option([^>]*)>([^<]+)</g)].map((m) => {
      const make = m[1].match(/class="(\d+)"/)?.[1] || '';
      const id = m[1].match(/value="(\d+)"/)?.[1] || '';
      const name = decodeEntities(m[2]).trim();
      return { id, make, name, f: fold(name) };
    }).filter((x) => x.id && x.make);
    if (!makes.length) {
      turboCatalogFailedAt = Date.now();
      if (!turboCatalog) turboCatalog = catalogFromBundle();
      return turboCatalog;
    }
    turboCatalog = { makes, models, at: Date.now() };
    return turboCatalog;
  })().finally(() => { turboCatalogLoading = null; });
  return turboCatalogLoading;
}

const MAKE_ALIASES: Record<string, string> = {
  mersedes: 'mercedes', merc: 'mercedes', benz: 'mercedes', 'mercedes benz': 'mercedes',
  vw: 'volkswagen', folksvagen: 'volkswagen', 'range rover': 'land rover', vaz: 'lada', jiguli: 'lada',
  toyot: 'toyota', hundai: 'hyundai', xendai: 'hyundai', sevrolet: 'chevrolet', shevrolet: 'chevrolet',
};
// Bu sözlər varsa, sorğu maşının özü yox, HİSSƏ/AKSESUARDIR ("bmw x5 təkər").
const CAR_PART_STEMS = new Set(['teker', 'disk', 'sin', 'fara', 'stop', 'bamper', 'kapot', 'qapi', 'guzgu', 'ehtiyat', 'hisse',
  'akkumulyator', 'yag', 'filtr', 'sesbogucu', 'aksesuar', 'ortuk', 'chexol', 'cexol', 'kovrik', 'maqnitola', 'radio', 'sensor',
  'kamera', 'oyuncaq', 'usaq', 'model', 'maket', 'naklejka', 'stiker', 'amortizator', 'motor', 'muherrik', 'karobka', 'reng',
  'tuning', 'tuninq', 'kuzov', 'salon', 'diffuzor', 'radiator', 'barmaqliq', 'spoyler', 'lyuk', 'aptechka', 'svet', 'lampa', 'akum']);
// Sorğuda HİSSƏ/AKSESUAR sözü varmı ("bmw x5 təkərləri" → "teker" kökü)?
function hasCarPartWord(foldedQuery: string): boolean {
  return foldedQuery.split(' ').some((w) => w && (CAR_PART_STEMS.has(w) || CAR_PART_STEMS.has(azStem(w))
    || [...CAR_PART_STEMS].some((st) => st.length >= 4 && w.startsWith(st))));
}

export interface CarQuery { makeId: string; makeName: string; modelIds: string[]; modelName: string | null; classLetter?: string }

// Sorğu konkret maşındırsa (marka tapıldı, hissə sözü yoxdur) marka/model ID-lərini qaytarır.
export async function detectCar(q: string): Promise<CarQuery | null> {
  let fq = ' ' + fold(q) + ' ';
  for (const [k, v] of Object.entries(MAKE_ALIASES)) fq = fq.replace(new RegExp(` ${k} `, 'g'), ` ${v} `);
  if (hasCarPartWord(fq.trim())) return null;
  const cat = await loadTurboCatalog();
  if (!cat) return null;
  // Ən uzun uyğun marka adı ("land rover" > "rover"; "bmw alpina" > "bmw").
  const make = cat.makes
    .filter((m) => m.f.length >= 2 && fq.includes(' ' + m.f + ' '))
    .sort((a, b) => b.f.length - a.f.length)[0]
    || cat.makes.filter((m) => m.f.length >= 3 && fq.includes(' ' + m.f.split(' ')[0] + ' ')).sort((a, b) => a.f.length - b.f.length)[0];
  if (!make) return null;
  const rest = ' ' + fq.replace(' ' + make.f + ' ', ' ').trim() + ' ';
  const glued = rest.replace(/\s+/g, '');
  const models = cat.models.filter((m) => m.make === make.id && m.f);
  // Model: əvvəlcə tam söz uyğunluğu ("x5"), sonra bitişik yazılış ("e class" ↔ "eclass").
  // "e class" / "c klass" / "s sinif" → həmin sinfin BÜTÜN modelləri (E 200, E 220 ...).
  const cls = rest.trim().match(/^([a-z]{1,3})[ -]?(class|klass|klas|sinif|sinfi)$/);
  if (cls) {
    const ids = models.filter((m) => new RegExp(`^${cls[1]} \\d`).test(m.f)).map((m) => m.id);
    if (ids.length) return { makeId: make.id, makeName: make.name, modelIds: ids, modelName: `${cls[1].toUpperCase()}-Class`, classLetter: cls[1] };
  }
  const model = models.filter((m) => rest.includes(' ' + m.f + ' ')).sort((a, b) => b.f.length - a.f.length)[0]
    || models.filter((m) => m.f.replace(/\s+/g, '').length >= 2 && glued.includes(m.f.replace(/\s+/g, ''))).sort((a, b) => b.f.length - a.f.length)[0]
    || null;
  // Marka tapıldı, amma model yazılıb və tanınmadısa ("bmw iphone") — maşın deyil.
  const leftover = rest.trim().split(' ').filter((w) => w && !/^\d{4}$/.test(w) && !(model && model.f.split(' ').includes(w)));
  if (!model && leftover.some((w) => !/^(masin|avtomobil|satilir|qiymet|ucuz|baki)$/.test(w))) return null;
  return { makeId: make.id, makeName: make.name, modelIds: model ? [model.id] : [], modelName: model?.name || null };
}

function parseTurboCards(html: string): WebResult[] {
  const out: WebResult[] = [];
  for (const raw of html.split(/<div class="products-i[ "]/).slice(1)) {
    const chunk = raw.slice(0, 4000);
    const href = chunk.match(/class="products-i__link"[^>]*href="(\/autos\/\d+[^"]*)"/)?.[1];
    if (!href) continue;
    const name = decodeEntities(chunk.match(/products-i__name[^>]*>([^<]+)</)?.[1] || '').trim();
    const attrs = decodeEntities(chunk.match(/products-i__attributes[^>]*>([^<]+)</)?.[1] || '').trim();
    if (!name) continue;
    const priceTxt = decodeEntities(chunk.match(/products-i__price[^>]*>([^<]+)</)?.[1] || '');
    const num = priceTxt.match(/\d[\d\s ]*/)?.[0];
    const cur = priceTxt.match(/₼|\$|€|AZN|USD|EUR/i)?.[0];
    out.push({
      title: `${name}${attrs ? ', ' + attrs : ''}`.slice(0, 160),
      url: `https://turbo.az${href}`,
      snippet: decodeEntities(chunk.match(/products-i__datetime[^>]*>([^<]+)</)?.[1] || '').trim(),
      price: num ? toNum(num) : null,
      currency: normCurrency(cur),
      site: 'turbo.az',
      kind: 'product',
      image: chunk.match(/<img[^>]+src="(https:\/\/[^"]+)"/)?.[1] || null,
      seller: null,
    });
  }
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

// Marka (+ model) üzrə turbo.az elanları — saytın standart sırası ilə.
async function searchTurboAz(car: CarQuery): Promise<WebResult[]> {
  const p = new URLSearchParams();
  p.append('q[make][]', car.makeId);
  for (const id of car.modelIds) p.append('q[model][]', id);
  // Qiymətə görə SIRALAMIRIQ — saytın öz (standart) sırası, Google-dakı kimi.
  const page = await getHtml(`https://turbo.az/autos?${p.toString()}`);
  if (!page) return [];
  // Sinif axtarışında yalnız marka yoxlanılır (model adları müxtəlifdir).
  const want = fold(`${car.makeName} ${car.modelIds.length === 1 ? car.modelName || '' : ''}`).split(' ').filter(Boolean);
  // Kartın adı marka/modelə uyğun olmalıdır (reklam blokları başqa maşın göstərə bilər).
  return parseTurboCards(page.html).filter((r) => matchesQuery(r.title.split(',')[0], want));
}

/**
 * Bütün mənbələrdə paralel axtarır.
 *  • Maşın sorğusu ("bmw x5") → turbo.az (marka/model üzrə, ən ucuzdan) + tap.az-ın
 *    yalnız AVTOMOBİL bölməsi. Hissə/aksesuar/oyuncaq elanları gəlmir.
 *  • Digər məhsullar → tap.az + lalafo.az.
 */
export async function searchShops(q: string): Promise<{ results: WebResult[]; isCar: boolean; car?: CarQuery | null }> {
  const tokens = queryTokens(q);
  if (!tokens.length) return { results: [], isCar: false };
  const car = await detectCar(q).catch(() => null);
  if (car) {
    const tapCarQuery = car.classLetter
      ? `${car.makeName} ${car.classLetter.toUpperCase()}`
      : `${car.makeName} ${car.modelIds.length === 1 ? car.modelName || '' : ''}`.trim();
    const tapCarTokens = queryTokens(car.classLetter ? car.makeName : tapCarQuery);
    const [turbo, tap] = await Promise.all([
      searchTurboAz(car).catch(() => [] as WebResult[]),
      // tap.az-ın "Avtomobillər" bölməsində axtarış — ümumi axtarışdan fərqli olaraq
      // burada yalnız maşınlar çıxır (hissə/oyuncaq yox). turbo.az əlçatan
      // olmayanda əsas mənbə budur.
      // Sorğu kimi kataloqdakı marka + model adı ("BMW X5", sinifdə "Mercedes E")
      // işlədilir — istifadəçinin yazılışından ("mersedes e class") asılı olmasın.
      searchTapAz(tapCarQuery, tapCarTokens, 'elanlar/neqliyyat/avtomobiller')
        .then((list) => (car.classLetter
          ? list.filter((r) => new RegExp(`\\b${car.classLetter}[ -]?\\d{2,3}\\b`, 'i').test(r.title))
          : list))
        .catch(() => [] as WebResult[]),
    ]);
    const tapCars = tap.filter((r) => /\/elanlar\/neqliyyat\/avtomobiller\//.test(r.url));
    console.log('[shopScrapers] maşın:', car.makeName, car.modelName || '-', '| turbo:', turbo.length, '| tap.az avto:', tapCars.length);
    return { results: [...turbo, ...tapCars], isCar: true, car };
  }
  // Saytların öz axtarışı şəkilçili sözləri pis tapır ("iphone 15 qabı", "kişi saatları").
  // Kök forma fərqlidirsə ("iphone 15 qab", "kisi saat") onunla da axtarırıq.
  const stemQ = tokens.map(azStem).join(' ');
  // Sinonim variantı: məhsul növü sözünü qrupun əsas sözü ilə əvəz et ("qabı" → "kabro").
  const synQ = tokens.map((t) => { const g = synonymsOf(t); return g && g[0] !== t && g[0] !== azStem(t) ? g[0] : azStem(t); }).join(' ');
  const variants = [...new Set([q, stemQ, synQ].filter((v, i) => i === 0 || v !== tokens.join(' ')))].slice(0, 3);
  const jobs = variants.flatMap((v) => [searchTapAz(v, tokens), searchLalafo(v, tokens)]);
  const settled = await Promise.allSettled(jobs);
  const lists = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  const seen = new Set<string>();
  // Sıra: orijinal sorğunun nəticələri əvvəl (tap.az, lalafo), sonra kök formanınkı.
  const merged = lists.flat().filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
  console.log('[shopScrapers] sorğu:', variants.join(' | '), '| nəticə:', lists.map((l) => l.length).join('/'), '| birləşmiş:', merged.length);
  return { results: merged, isCar: false };
}

// ── Ümumi məhsul səhifəsi yoxlaması (Tavily nəticələri üçün) ──────────────────
// Axtarış motorunun verdiyi linki AÇIB yoxlayırıq: (1) həqiqətən məhsul səhifəsidir
// (JSON-LD Product / og:type=product / qiymət meta etiketi), (2) ana səhifəyə
// yönləndirmir, (3) qiymət və şəkil səhifənin ÖZÜNDƏN götürülür — snippet-dən yox.
export interface ProductPage {
  url: string;
  title: string | null;
  price: number | null;
  currency: string;
  image: string | null;
  isProduct: boolean;
}

function meta(html: string, prop: string): string | null {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${esc}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : null;
}

function findLdProduct(html: string): any | null {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let j: any;
    try { j = JSON.parse(body); } catch { continue; }
    const stack = [j];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) { stack.push(...o); continue; }
      const t = o['@type'];
      if (t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'Car' || t === 'Vehicle') return o;
      if (o['@graph']) stack.push(o['@graph']);
    }
  }
  return null;
}

export async function fetchProductPage(url: string): Promise<ProductPage | null> {
  const page = await getHtml(url);
  if (!page) return null;
  const { html, finalUrl } = page;
  // Ana səhifəyə / kökə yönləndirildisə — elan silinib və ya link səhvdir.
  try { if (new URL(finalUrl).pathname.replace(/\/+$/, '') === '') return null; } catch { return null; }

  const ld = findLdProduct(html);
  let offer = ld?.offers;
  if (Array.isArray(offer)) offer = offer[0];
  if (offer?.['@type'] === 'AggregateOffer') offer = { price: offer.lowPrice ?? offer.price, priceCurrency: offer.priceCurrency };

  // turbo.az elan səhifəsində JSON-LD/meta qiymət yoxdur — görünən qiymət bloku.
  const turboPrice = /turbo\.az$/.test(new URL(finalUrl).hostname)
    ? decodeEntities(html.match(/product-price__i--bold[^>]*>([^<]+)</)?.[1] || '') : '';
  const turboNum = turboPrice.match(/\d[\d\s\u00a0]*/)?.[0];
  const price = toNum(offer?.price)
    ?? (turboNum ? toNum(turboNum) : null)
    ?? toNum(meta(html, 'product:price:amount'))
    ?? toNum(meta(html, 'og:price:amount'))
    ?? toNum(meta(html, 'price'));
  const currency = normCurrency(offer?.priceCurrency || turboPrice.match(/₼|\$|€/)?.[0] || meta(html, 'product:price:currency') || meta(html, 'og:price:currency') || meta(html, 'priceCurrency'));

  let image: string | null = null;
  const ldImg = ld?.image;
  image = (Array.isArray(ldImg) ? ldImg[0] : typeof ldImg === 'object' ? ldImg?.url : ldImg) || meta(html, 'og:image') || meta(html, 'twitter:image');
  if (image) { try { image = new URL(String(image), finalUrl).toString(); } catch { image = null; } }

  const ogType = (meta(html, 'og:type') || '').toLowerCase();
  const isProduct = !!ld || ogType.includes('product') || price != null;
  const title = (ld?.name && String(ld.name)) || meta(html, 'og:title') || null;
  return { url: finalUrl, title: title ? title.slice(0, 160) : null, price, currency, image, isProduct };
}

// URL konkret məhsul/elan səhifəsinə bənzəyirmi? (kök, kateqoriya, axtarış yox)
export function looksLikeProductUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    if (!path) return false;
    if (/\/(search|axtaris|catalogsearch|kateqoriya|category|categories|brand|brands|tag|blog|news|xeberler)(\/|$)/i.test(path)) return false;
    if (u.searchParams.has('q') || u.searchParams.has('query') || u.searchParams.has('keywords')) return false;
    const segs = path.split('/').filter(Boolean);
    // Rəqəmsal ID və ya uzun slug (məhsul adı) — tipik məhsul səhifəsi.
    return /\d{3,}/.test(path) || segs.some((s) => s.split('-').length >= 3);
  } catch { return false; }
}

// ── Dəqiqlik süzgəci ────────────────────────────────────────────────────────
// Google-da "iphone 15" yazanda əvvəlcə məhz iPhone 15 çıxır — "15 Pro Max",
// ekran, qab, təmir yox. Burada da: sorğuda olmayan VARİANT sözü (pro, max,
// ultra, plus, fe ...) və ya HİSSƏ/AKSESUAR sözü başlıqda varsa elan atılır.
// Bu sərt süzgəcdən sonra 5-dən az qalırsa, mərhələli yumşaldılır.
const VARIANT_WORDS = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'lite', 'air', 'se', 'note', 'slim', 'digital', 'portal', 'edge', 'neo'];
const PART_WORDS = ['ekran', 'ekrani', 'ekranlari', 'displey', 'batareya', 'batareyasi', 'korpus', 'qab', 'qabi', 'kabro', 'cexol', 'chexol', 'case',
  'suse', 'plyonka', 'temir', 'temiri', 'ehtiyat', 'hisse', 'hisseleri', 'adapter', 'kabel', 'sarj', 'sarjer', 'ucun', 'for', 'oyunlari',
  'disk', 'pult', 'joystick', 'dualsense', 'kreditle', 'alisi', 'alinir', 'aliram', 'icare', 'icaresi', 'kiraye', 'stiker', 'naklejka', 'qutu', 'qutusu', 'maket', 'oyuncaq',
  'oyunu', 'balans', 'artirilmasi', 'abuneliyi', 'abunelik', 'sehifesi', 'hesab', 'hesabi', 'kod', 'kodu', 'hediyye', 'gift', 'card', 'drive', 'gamepad', 'stend', 'stand', 'soyuducu'];

export function refineRelevance(items: WebResult[], q: string, min = 5): WebResult[] {
  const qw = new Set(queryTokens(q));
  const words = (t: string) => fold(t).split(' ');
  const hasForeign = (t: string, list: string[]) => words(t).some((w) => list.includes(w) && !qw.has(w));
  const noParts = items.filter((r) => !hasForeign(r.title, PART_WORDS));
  const strict = noParts.filter((r) => !hasForeign(r.title, VARIANT_WORDS));
  if (strict.length >= min) return strict;
  // Hissə/aksesuar elanlarını (disk, qab, ekran ...) az nəticə olanda belə QAYTARMIRIQ —
  // yanlış məhsul göstərməkdənsə az nəticə yaxşıdır. Yalnız variant süzgəci yumşaldılır.
  return noParts.length ? noParts : items.filter(() => false);
}
