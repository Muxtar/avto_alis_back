// Saytdaxili axtarış nəticə vermədikdə internetdən axtarış — Claude (Anthropic)
// web_search server aləti ilə. İstifadəçi başlıqdakı axtarışda məhsul və ya
// otel adı yazır; saytda tapılmazsa nəticələr internetdən gətirilir.
//
// ANTHROPIC_API_KEY mühit dəyişəni tələb olunur (Railway → Variables).

import Anthropic from '@anthropic-ai/sdk';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
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

Cavab dili: Azərbaycan dili.`;

function prompt(query: string): string {
  return `İstifadəçi bizim saytda "${query}" axtardı, saytda uyğun elan tapılmadı.

Bunu internetdə axtar və Azərbaycanda mövcud olan ən uyğun 4-6 nəticəni tap.
Axtararkən sorğuya "Azərbaycan" və ya "Bakı" kimi yer göstəricisi əlavə et.

Sorğu qısa və ya qısaldılmış ola bilər (məs. "x5" → BMW X5 avtomobili,
"s24" → Samsung Galaxy S24, "air 2" → iPad Air 2). Belə halda əvvəlcə onun
nə demək olduğunu müəyyən et, sonra tam adla axtar. Bir neçə məna varsa,
Azərbaycanda ən çox axtarılanı seç.

ƏVVƏLCƏ bu Azərbaycan platformalarına bax (sorğunu "site:" ilə də sına,
məs. "site:tap.az ${query}"):
- Ümumi elanlar: tap.az, lalafo.az
- Avtomobil: turbo.az
- Daşınmaz əmlak: bina.az
- Onlayn mağaza / məhsul: umico.az, kontakt.az, irshad.az, bakuelectronics.az, birmarket.az
Bu saytlarda uyğun nəticə tapsan, onları siyahının BAŞINA qoy.
Tapmasan, digər Azərbaycan mənbələrinə keç.

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
      "title": "səhifənin başlığı",
      "url": "tam https ünvan",
      "snippet": "1 cümlə izah — nə olduğu və Azərbaycanla əlaqəsi",
      "az_reason": "niyə bu nəticə Azərbaycana aiddir (qısa)"
    }
  ]
}

Qeyd: "az_reason"-u özün üçün yaz — hər nəticəni siyahıya salmadan əvvəl onun
Azərbaycanla əlaqəsini yoxla. Əlaqəni izah edə bilmirsənsə, nəticəni at.`;
}

/**
 * Sorğunu internetdə axtarır və struktur nəticələr qaytarır.
 * @param query istifadəçinin axtarış mətni
 */
export async function webSearch(query: string): Promise<WebSearchResponse> {
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'İnternet axtarışı konfiqurasiya edilməyib.' };

  const q = query.trim().slice(0, 200);
  if (!q) return { ...EMPTY, error: 'Axtarış mətni boşdur.' };

  console.log('[webSearch] başladı — sorğu:', q, '| model:', AI_MODEL);

  // Alət konfiqurasiyaları — sıra ilə sınanır. Yeni versiya (dinamik filtr +
  // user_location + blocked_domains) hesabda dəstəklənmirsə, sadə versiyaya
  // düşürük ki, axtarış tamamilə sıradan çıxmasın.
  const TOOL_VARIANTS: any[] = [
    {
      type: 'web_search_20260209', name: 'web_search', max_uses: 5,
      user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
      blocked_domains: BLOCKED_DOMAINS,
    },
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    {
      type: 'web_search_20250305', name: 'web_search', max_uses: 5,
      user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
    },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
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
          max_tokens: 2000,
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
        .slice(0, 6)
        .map((r: any) => ({
          title: String(r.title || r.url).slice(0, 160),
          url: String(r.url),
          snippet: String(r.snippet || '').slice(0, 300),
        }))
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
  return {
    ok: true,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : '',
    results,
  };
}

export function webSearchEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
