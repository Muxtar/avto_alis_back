// Saytdaxili axtarış nəticə vermədikdə internetdən axtarış.
// İstifadəçi başlıqdakı axtarışda məhsul/otel adı yazır; saytda tapılmazsa
// nəticələr internetdən gətirilir.
//
// İki yol var (dispatcher `webSearch` seçir):
//   1) TAVILY_API_KEY varsa → Tavily axtarış motoru (ucuz, sürətli) +
//      istəyə görə Haiku 4.5 ilə qiymət/xülasə təmizlənməsi. ƏSAS yol.
//   2) Yalnız ANTHROPIC_API_KEY varsa → köhnə Claude web_search yolu (ehtiyat,
//      keçid dövrü üçün — Tavily açarı əlavə edilənə qədər sayt işləsin).
//
// Railway → Variables:
//   TAVILY_API_KEY      — tavily.com pulsuz açarı (əsas axtarış)
//   ANTHROPIC_API_KEY   — Haiku təmizləmə + Claude ehtiyat yolu (istəyə görə)
//   WEB_SEARCH_REFINE_MODEL — default 'claude-haiku-4-5'

import Anthropic from '@anthropic-ai/sdk';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  price: number | null;   // AZN — səhifədə görünürsə
  site: string;           // mənbə sayt (tap.az, turbo.az ...)
}

export interface WebSearchResponse {
  ok: boolean;
  summary: string;      // qısa Azərbaycanca xülasə
  results: WebResult[];
  error?: string;
}

const EMPTY: WebSearchResponse = { ok: false, summary: '', results: [] };

const AI_MODEL = process.env.WEB_SEARCH_MODEL || 'claude-opus-4-8';

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

function parseJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : (text.match(/\{[\s\S]*\}/)?.[0] || text);
  try { return JSON.parse(candidate); } catch { return null; }
}

// ── Azərbaycan filtri ────────────────────────────────────────────────────────
// Üç qat: (1) alət səviyyəsi (user_location + blocked_domains),
// (2) prompt səviyyəsi (aşağıdakı SYSTEM/prompt), (3) kod səviyyəsi (isAzResult).
// Model qaydanı pozsa belə, kod filtri son söz sahibidir.

// Azərbaycan şirkətlərinin .az olmayan domenləri (nadir hal).
const AZ_BRAND_DOMAINS = new Set([
  // Elan / pazar platformaları
  'tap.az', 'turbo.az', 'bina.az', 'lalafo.az', 'lalafo.com', 'umico.az',
  'birmarket.az', 'emalls.az', 'boss.az', 'jobsearch.az',
  // Mağaza şəbəkələri
  'kontakt.az', 'irshad.az', 'bakuelectronics.az', 'trendyol.az',
  'soliton.az', 'texnomart.az', 'optimal.az',
]);

// Beynəlxalq saytlarda Azərbaycana aid səhifəni tanıyan izlər.
const AZ_PATH_HINTS = /(\/az\/|azerbaijan|azerbaycan|az[eə]rbaycan|\bbaku\b|-baku|\bbaki\b|\bganja\b|\bnakhchivan\b|\bqabala\b|\bshaki\b)/i;

// Nəticə Azərbaycana aiddirsə true. Şübhə varsa false (nəticə atılır).
export function isAzResult(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'az' || host.endsWith('.az')) return true;   // .az domenləri
    if (AZ_BRAND_DOMAINS.has(host)) return true;              // tanınmış AZ brendləri
    return AZ_PATH_HINTS.test(host + u.pathname);             // beynəlxalq saytın AZ səhifəsi
  } catch {
    return false;
  }
}

// Azərbaycanla əlaqəsi olmayan qlobal pazarlar — alət səviyyəsində bağlanır.
const BLOCKED_DOMAINS = [
  'amazon.com', 'aliexpress.com', 'ebay.com', 'hepsiburada.com',
  'trendyol.com', 'wildberries.ru', 'ozon.ru', 'temu.com',
];

const SYSTEM = `Sən tradixai (Azərbaycan onlayn elan platforması) üçün internet axtarışı köməkçisisən.
İstifadəçi saytda nəsə axtarıb, amma nəticə tapılmayıb. Sənin işin həmin sorğunu
internetdə axtarıb YALNIZ AZƏRBAYCANA AİD nəticələr qaytarmaqdır.

Coğrafi qayda (ən vacib qayda — heç vaxt pozma):
- Nəticə Azərbaycanda satılan, yerləşən və ya Azərbaycandan sifariş edilə bilən olmalıdır.
  Azərbaycanla əlaqəsi olmayan nəticəni SİYAHIYA SALMA.
- Üstünlük sırası: (1) .az domenləri və Azərbaycan şirkətlərinin rəsmi saytları,
  (2) beynəlxalq saytların Azərbaycan bölməsi (məs. booking.com-un Bakı oteli səhifəsi),
  (3) başqa heç nə.
- Beynəlxalq sayt yalnız o halda uyğundur ki, HƏMİN SƏHİFƏ Azərbaycandakı məhsul/məkan
  haqqında olsun. Ümumi qlobal səhifə uyğun deyil.
- Şübhə varsa nəticəni at. Az sayda düzgün nəticə, çox sayda uyğunsuzdan yaxşıdır.

Dürüstlük qaydası:
- Yalnız axtarış nəticələrindən gələn REAL ünvanları yaz. URL uydurma.
- Qiymət, ünvan, telefon kimi məlumatı yalnız səhifədə görmüsənsə yaz.
- Heç nə tapmasan, boş siyahı qaytar və bunu açıq bildir. Uydurma ilə doldurma.
- Axtarış sayı məhduddur. Limitə çatmamış tapdıqlarını qaytar; limit bəhanəsi ilə
  boş cavab vermə.

Cavab dili: Azərbaycan dili.`;

function prompt(query: string): string {
  return `İstifadəçi bizim saytda "${query}" axtardı, saytda uyğun elan tapılmadı.

Bunu internetdə axtar və Azərbaycanda mövcud olan ən uyğun 4-6 nəticəni tap.
Axtararkən sorğuya "Azərbaycan" və ya "Bakı" kimi yer göstəricisi əlavə et.

Sorğu qısa və ya qısaldılmış ola bilər (məs. "x5" → BMW X5 avtomobili,
"s24" → Samsung Galaxy S24, "air 2" → iPad Air 2). Belə halda əvvəlcə onun
nə demək olduğunu müəyyən et, sonra tam adla axtar. Bir neçə məna varsa,
Azərbaycanda ən çox axtarılanı seç.

AXTARIŞ BÜDCƏSİ: təxminən 10 axtarışın var. Onu səmərəli xərclə —
hər saytı ayrıca yoxlamağa çalışma, büdcə bitər və əliboş qalarsan.

Strategiya (bu sıra ilə):
1. 1-2 ümumi axtarış: "<məhsul adı> Azərbaycan" və "<məhsul adı> Bakı qiymət".
   Çox vaxt bu, tap.az / lalafo.az / umico.az nəticələrini onsuz da gətirir.
2. Hələ də azdırsa, YALNIZ ən uyğun 1-2 platformada "site:" ilə axtar:
   - Avtomobil → site:turbo.az
   - Ev/mənzil/torpaq → site:bina.az
   - Digər məhsullar → site:tap.az və ya site:lalafo.az
3. Qalan büdcəni ehtiyatda saxla.

Bu platformalardan nəticə tapsan, onları siyahının BAŞINA qoy:
tap.az, lalafo.az, turbo.az (avtomobil), bina.az (əmlak),
umico.az / kontakt.az / irshad.az / bakuelectronics.az / birmarket.az (mağaza).

VACİB: axtarış büdcən bitməyə yaxınlaşırsa, DAYAN və o ana qədər tapdığın
etibarlı nəticələri qaytar. Əliboş cavab vermə — 1-2 düzgün nəticə də
heç nədən yaxşıdır. (Yenə də uydurma URL yazma.)

Nəticə tipləri (sorğuya uyğun olanı seç):
- Məhsuldursa: yuxarıdakı elan/mağaza platformalarının məhsul səhifələri
- Avtomobildirsə: turbo.az elan səhifəsi
- Ev/mənzil/torpaqdırsa: bina.az və ya tap.az elan səhifəsi
- Otel/məkandırsa: rəsmi sayt və ya rezervasiya səhifəsi (Azərbaycandakı obyekt)
- Xidmətdirsə: xidməti Azərbaycanda göstərən şirkətin səhifəsi

Axtarışı bitirdikdən sonra YALNIZ bu JSON-u qaytar, başqa heç nə yazma:
{
  "summary": "1-2 cümlə Azərbaycan dilində qısa xülasə",
  "results": [
    {
      "title": "elanın / məhsulun adı",
      "url": "tam https ünvan",
      "site": "mənbə sayt, məs. tap.az",
      "price": 1250,
      "snippet": "1 cümlə izah — nə olduğu və Azərbaycanla əlaqəsi",
      "az_reason": "niyə bu nəticə Azərbaycana aiddir (qısa)"
    }
  ]
}

"price" haqqında:
- YALNIZ axtarış nəticəsində/səhifədə həqiqətən gördüyün qiyməti yaz.
- Yalnız RƏQƏM yaz, AZN ilə: 1250 (── "1250 AZN", "1.250" və ya mətn YOX).
- Qiymət dollar/avro ilədirsə, təxmini çevirmə etmə — price: null qoy.
- Qiyməti görmürsənsə price: null. Təxmin etmə, uydurma.

Qeyd: "az_reason"-u özün üçün yaz — hər nəticəni siyahıya salmadan əvvəl onun
Azərbaycanla əlaqəsini yoxla. Əlaqəni izah edə bilmirsənsə, nəticəni at.`;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
/**
 * Sorğunu internetdə axtarır və struktur nəticələr qaytarır.
 * TAVILY_API_KEY varsa Tavily (+ Haiku) istifadə olunur; yoxdursa köhnə
 * Claude web_search yoluna düşülür. İstifadəçiyə qaytarılan forma eynidir.
 * @param query istifadəçinin axtarış mətni
 */
export async function webSearch(query: string): Promise<WebSearchResponse> {
  const q = query.trim().slice(0, 200);
  if (!q) return { ...EMPTY, error: 'Axtarış mətni boşdur.' };
  if (process.env.TAVILY_API_KEY) return webSearchTavily(q);
  if (process.env.ANTHROPIC_API_KEY) return webSearchClaude(q);
  return { ...EMPTY, error: 'İnternet axtarışı konfiqurasiya edilməyib.' };
}

// ── Tavily yolu (əsas) ───────────────────────────────────────────────────────
const TAVILY_URL = 'https://api.tavily.com/search';
const REFINE_MODEL = process.env.WEB_SEARCH_REFINE_MODEL || 'claude-haiku-4-5';

// Snippet/başlıqdan AZN qiymətini çıxaran ehtiyat regex (Haiku olmayanda və ya
// tapmadıqda). Yalnız açıq AZN/manat işarəsi olan qiyməti qəbul edir.
function extractPriceAzn(text: string): number | null {
  if (!text) return null;
  const m = text.match(/(\d[\d\s.,]{0,12}\d|\d)\s*(?:azn|₼|manat|man\b)/i)
        || text.match(/(?:qiym[əe]t|price)\D{0,4}(\d[\d\s.,]{0,12}\d|\d)/i);
  if (!m) return null;
  const n = parseFloat(
    m[1].replace(/[^\d.,]/g, '').replace(/[.\s](?=\d{3}\b)/g, '').replace(',', '.'),
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function webSearchTavily(q: string): Promise<WebSearchResponse> {
  console.log('[webSearch] Tavily başladı — sorğu:', q);

  let data: any;
  try {
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query: `${q} Azərbaycan`,
        search_depth: 'basic',      // 'basic' = 1 kredit; 'advanced' = 2 kredit
        topic: 'general',
        country: 'azerbaijan',      // nəticələri AZ-ə meyilləndirir
        max_results: 12,
        include_answer: true,       // hazır 1-2 cümlə xülasə
        exclude_domains: BLOCKED_DOMAINS,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[webSearch] Tavily HTTP', resp.status, body.slice(0, 300));
      const msg = resp.status === 401 || resp.status === 403 ? 'Axtarış açarı etibarsızdır.'
        : resp.status === 429 ? 'Axtarış limiti doldu, bir azdan yenidən cəhd edin.'
        : 'İnternet axtarışı alınmadı. Yenidən cəhd edin.';
      return { ...EMPTY, error: msg };
    }
    data = await resp.json();
  } catch (e: any) {
    console.error('[webSearch] Tavily xəta:', e?.name, e?.message);
    return { ...EMPTY, error: 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
  }

  const rawResults: any[] = Array.isArray(data?.results) ? data.results : [];

  // AZ filtri — .az, tanınmış AZ brendləri, və ya beynəlxalq saytın AZ səhifəsi.
  const azResults = rawResults.filter(
    (r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && isAzResult(r.url),
  );

  if (rawResults.length > 0 && azResults.length === 0) {
    console.warn('[webSearch] Tavily: nəticələr AZ filtrindən keçmədi — sorğu:', q);
    return {
      ok: true,
      summary: 'Nəticələr tapıldı, amma Azərbaycana aid olmadığı üçün göstərilmədi.',
      results: [],
    };
  }
  if (azResults.length === 0) return { ok: true, summary: '', results: [] };

  // İlkin xəritələmə (regex qiymət ilə). Haiku sonra dəqiqləşdirə bilər.
  let items: WebResult[] = azResults.slice(0, 8).map((r) => {
    let site = '';
    try { site = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
    const content = String(r.content || '');
    return {
      title: String(r.title || r.url).slice(0, 160),
      url: String(r.url),
      snippet: content.slice(0, 300),
      price: extractPriceAzn(`${content} ${r.title || ''}`),
      site: site.slice(0, 60),
    };
  });

  let summary = typeof data?.answer === 'string' ? data.answer.slice(0, 400) : '';

  // Haiku təmizləmə (ANTHROPIC_API_KEY varsa) — qiymət + snippet + xülasə.
  const refined = await refineWithHaiku(q, items, summary);
  if (refined) {
    items = refined.items;
    if (refined.summary) summary = refined.summary;
  }

  // Ucuzdan bahaya; qiyməti bilinməyənlər sona.
  items.sort((a, b) => {
    if (a.price == null && b.price == null) return 0;
    if (a.price == null) return 1;
    if (b.price == null) return -1;
    return a.price - b.price;
  });
  items = items.slice(0, 6);

  console.log('[webSearch] Tavily sorğu:', q, '| xam:', rawResults.length,
    '| AZ:', azResults.length, '| göstərilən:', items.length);
  return { ok: true, summary, results: items };
}

// Tavily snippet-lərini ucuz Haiku ilə təmizləyir: AZN qiyməti, qısa izah və
// ümumi xülasə. Yalnız verilən nəticələrlə işləyir — yeni URL uydurmur.
async function refineWithHaiku(
  q: string,
  items: WebResult[],
  tavilyAnswer: string,
): Promise<{ summary: string; items: WebResult[] } | null> {
  const ai = getClient();
  if (!ai || items.length === 0) return null;

  const list = items
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\nMətn: ${r.snippet}`)
    .join('\n\n');

  const sys = 'Sən tradixai (Azərbaycan elan platforması) üçün internet axtarış '
    + 'nəticələrini təmizləyirsən. YALNIZ verilən nəticələrlə işlə — yeni nəticə '
    + 'və ya yeni URL uydurma. Cavab dili: Azərbaycan dili.';

  const user = `İstifadəçi "${q}" axtardı. Aşağıdakı nəticələr üçün:
1) Azərbaycan dilində 1-2 cümləlik ümumi xülasə ("summary").
2) Hər nəticə üçün: səhifə mətnində AÇIQ AZN qiyməti varsa onu RƏQƏM kimi ("price"),
   görünmürsə və ya USD/EUR/RUB-dursa null; 1 cümləlik qısa izah ("snippet").

Nəticələr:
${list}

YALNIZ bu JSON-u qaytar, başqa heç nə yazma:
{"summary":"...","items":[{"i":0,"price":1250,"snippet":"..."}]}`;

  try {
    const res: any = await ai.messages.create({
      model: REFINE_MODEL,
      max_tokens: 1200,
      system: sys,
      messages: [{ role: 'user', content: user }],
    });
    const text = res.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    const parsed = parseJson(text);
    if (!parsed || !Array.isArray(parsed.items)) return null;

    const byIndex = new Map<number, any>();
    for (const it of parsed.items) if (it && Number.isInteger(it.i)) byIndex.set(it.i, it);

    const out = items.map((r, i) => {
      const it = byIndex.get(i);
      if (!it) return r;
      // Haiku müsbət rəqəm verirsə qəbul et; yoxsa regex nəticəsini saxla.
      let price = r.price;
      if (typeof it.price === 'number' && Number.isFinite(it.price) && it.price > 0) price = it.price;
      const snippet = typeof it.snippet === 'string' && it.snippet.trim()
        ? it.snippet.slice(0, 300) : r.snippet;
      return { ...r, price, snippet };
    });

    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.slice(0, 400) : tavilyAnswer,
      items: out,
    };
  } catch (e: any) {
    console.error('[webSearch] Haiku təmizləmə xətası:', e?.status, e?.message);
    return null;   // təmizləmə alınmasa xam Tavily nəticələri istifadə olunur
  }
}

// ── Claude yolu (ehtiyat — Tavily açarı yoxdursa) ─────────────────────────────
async function webSearchClaude(q: string): Promise<WebSearchResponse> {
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'İnternet axtarışı konfiqurasiya edilməyib.' };

  console.log('[webSearch] Claude (ehtiyat) başladı — sorğu:', q, '| model:', AI_MODEL);

  // Alət konfiqurasiyaları — sıra ilə sınanır. Yeni versiya (dinamik filtr +
  // user_location + blocked_domains) hesabda dəstəklənmirsə, sadə versiyaya
  // düşürük ki, axtarış tamamilə sıradan çıxmasın.
  const TOOL_VARIANTS: any[] = [
    {
      type: 'web_search_20260209', name: 'web_search', max_uses: 10,
      user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
      blocked_domains: BLOCKED_DOMAINS,
    },
    { type: 'web_search_20260209', name: 'web_search', max_uses: 10 },
    {
      type: 'web_search_20250305', name: 'web_search', max_uses: 10,
      user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
    },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
  ];

  let text = '';
  let lastError: any = null;

  for (let v = 0; v < TOOL_VARIANTS.length && !text; v++) {
    const messages: any[] = [{ role: 'user', content: prompt(q) }];
    try {
      // Server aləti işləyərkən model `pause_turn` ilə dayana bilər —
      // bu halda cavabı geri göndərib davam etdiririk.
      for (let i = 0; i < 6; i++) {
        const res: any = await ai.messages.create({
          model: AI_MODEL,
          max_tokens: 3000,
          system: SYSTEM,
          tools: [TOOL_VARIANTS[v]],
          messages,
        });
        if (res.stop_reason === 'refusal') return { ...EMPTY, error: 'Bu sorğu üçün axtarış edilə bilmədi.' };
        if (res.stop_reason === 'pause_turn') {
          messages.push({ role: 'assistant', content: res.content });
          continue;
        }
        text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        break;
      }
      if (v > 0 && text) console.warn('[webSearch] alət variantı', v, 'ilə işlədi:', TOOL_VARIANTS[v].type);
    } catch (e: any) {
      lastError = e;
      // Provayder xəta mətni kənara sızdırılmır — yalnız daxili log.
      // Səbəbi ayırd etmək üçün: açar, model adı və ya alət versiyası problemi.
      console.error('[webSearch] variant', v, TOOL_VARIANTS[v].type, 'xəta:',
        e?.status, e?.name, e?.message, e?.error ? JSON.stringify(e.error).slice(0, 400) : '');
      // 400 = alət/parametr qəbul edilmədi → növbəti varianta keç.
      // Digər xətalarda (401/429/5xx) variant dəyişmək kömək etmir.
      if (e?.status !== 400) break;
    }
  }

  if (!text && lastError) {
    const st = lastError?.status;
    const msg = st === 401 ? 'AI açarı etibarsızdır.'
      : st === 429 ? 'Axtarış limiti doldu, bir azdan yenidən cəhd edin.'
      : st === 404 ? 'AI modeli əlçatan deyil.'
      : 'İnternet axtarışı alınmadı. Yenidən cəhd edin.';
    return { ...EMPTY, error: msg };
  }


  if (!text) {
    console.error('[webSearch] boş cavab (pause_turn limiti?) — sorğu:', q);
    return { ...EMPTY, error: 'Axtarış tamamlanmadı. Yenidən cəhd edin.' };
  }

  const parsed = parseJson(text);
  if (!parsed) {
    console.error('[webSearch] JSON oxunmadı — sorğu:', q, '| cavabın başı:', text.slice(0, 200));
    return { ...EMPTY, error: 'Nəticələr oxunmadı.' };
  }

  const raw: any[] = Array.isArray(parsed.results) ? parsed.results : [];
  const results: WebResult[] = Array.isArray(parsed.results)
    ? parsed.results
        // Son güvənlik qatı: model qaydanı pozsa belə, Azərbaycana aid
        // olmayan nəticə buraxılmır. "az_reason" daxili yoxlama üçündür,
        // istifadəçiyə göndərilmir.
        .filter((r: any) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && isAzResult(r.url))
        .map((r: any) => {
          // Qiyməti yalnız təmiz rəqəm kimi qəbul edirik; "1.250 AZN" kimi
          // mətn gəlsə də rəqəmə çeviririk, alınmasa null.
          let price: number | null = null;
          if (typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0) {
            price = r.price;
          } else if (typeof r.price === 'string') {
            // Xarici valyuta (USD/EUR/RUB) AZN kimi göstərilməməlidir — belə
            // qiyməti atırıq, əks halda "1500 $" ucuz AZN kimi sıralanardı.
            const foreign = /[$€₽]|usd|eur|dollar|avro|rub/i.test(r.price);
            if (!foreign) {
              const n = parseFloat(r.price.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
              if (Number.isFinite(n) && n > 0) price = n;
            }
          }
          let site = String(r.site || '').trim().toLowerCase();
          if (!site) { try { site = new URL(r.url).hostname.replace(/^www\./, ''); } catch { site = ''; } }
          return {
            title: String(r.title || r.url).slice(0, 160),
            url: String(r.url),
            snippet: String(r.snippet || '').slice(0, 300),
            price,
            site: site.slice(0, 60),
          };
        })
        // Ucuzdan bahaya. Qiyməti bilinməyənlər sona düşür.
        .sort((a: WebResult, b: WebResult) => {
          if (a.price == null && b.price == null) return 0;
          if (a.price == null) return 1;
          if (b.price == null) return -1;
          return a.price - b.price;
        })
        .slice(0, 6)   // sıralamadan SONRA kəsirik ki, ən ucuzlar itməsin
    : [];

  // Model nəticə tapıb, amma hamısı Azərbaycan filtrindən keçməyibsə —
  // bunu "heç nə tapılmadı"dan fərqləndiririk (həm log, həm istifadəçi üçün).
  if (raw.length > 0 && results.length === 0) {
    console.warn('[webSearch] bütün nəticələr AZ filtrindən keçmədi — sorğu:', q,
      '| atılan:', raw.map((r: any) => r?.url).filter(Boolean).join(', ').slice(0, 300));
    return {
      ok: true,
      summary: 'Nəticələr tapıldı, amma Azərbaycana aid olmadığı üçün göstərilmədi.',
      results: [],
    };
  }

  console.log('[webSearch] sorğu:', q, '| model:', raw.length, '| AZ filtrindən keçən:', results.length);

  // Nəticə yoxdursa modelin öz izahını (məs. "limit aşıldı") istifadəçiyə
  // göstərmirik — qarışıq və narahatedicidir. Sadə mesaj kifayətdir.
  if (results.length === 0) return { ok: true, summary: '', results: [] };

  return {
    ok: true,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : '',
    results,
  };
}

export function webSearchEnabled(): boolean {
  return !!(process.env.TAVILY_API_KEY || process.env.ANTHROPIC_API_KEY);
}
