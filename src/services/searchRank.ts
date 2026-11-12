// AI uyğunluq süzgəci — internet axtarışında tapılan elanlardan YALNIZ axtarılan
// məhsulun özünü saxlayır və onları axtarış motoru kimi uyğunluğa görə sıralayır.
//
// Niyə: söz uyğunluğu ("bmw x5" sözləri başlıqda var) kifayət etmir — oyuncaq
// maşın, ehtiyat hissə, telefon qabı, təmir xidməti, "alıram" elanı da həmin
// sözləri daşıyır. Model hər elanın başlığına + saytdakı kateqoriyasına baxıb
// "bu, axtarılan məhsulun özüdürmü?" sualına cavab verir. Bu, bütün məhsul
// növləri üçün eyni işləyir (siyahı saxlamaq lazım deyil).
//
// Açar yoxdursa / xəta olarsa null qaytarır — çağıran evristik sıraya düşür.
//
// Railway → Variables:
//   ANTHROPIC_API_KEY       — tələb olunur
//   WEB_SEARCH_RANK_MODEL   — default 'claude-opus-5-5' (daha ucuz/sürətli üçün 'claude-haiku-5-5')

import Anthropic from '@anthropic-ai/sdk';
import type { WebResult } from './webSearchAI';

const RANK_MODEL = process.env.WEB_SEARCH_RANK_MODEL || 'claude-opus-5-5';
const MAX_CANDIDATES = 30;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
  return client;
}

export function aiRankEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM = `Sən Azərbaycan elan saytlarında (tap.az, lalafo.az, turbo.az və mağazalar) məhsul axtarışının uyğunluq hakimisən.
İstifadəçi bir məhsul adı yazır. Sənə namizəd elanlar verilir (nömrə, başlıq, saytdakı kateqoriya, qiymət).

Vəzifən: YALNIZ istifadəçinin axtardığı məhsulun ÖZÜNÜ satan elanları seç və onları Google kimi ən uyğundan başlayaraq sırala.

Atılmalı olanlar (istifadəçi sorğuda bunu açıq istəməyibsə):
- oyuncaq, maket, kolleksiya modeli, uşaq maşını ("bmw x5" → oyuncaq BMW X5 YOX)
- ehtiyat hissə, aksesuar, qab, ekran, batareya, təkər, disk, kabel, şarj ("iphone 15" → iPhone 15 qabı YOX)
- xidmət: təmir, icarə, kirayə, quraşdırma, kurs, çatdırılma
- "alıram", "alınır", "dəyişirəm" kimi alış/barter elanları
- rəqəmsal məhsullar: oyun, abunəlik, balans, hesab ("playstation 5" → PS5 oyunu YOX)
- başqa model/nəsil ("iphone 15" → iPhone 14 və ya 16 YOX; "samsung s24" → S23 YOX)

Variantlar: sorğuda variant göstərilməyibsə (pro, max, ultra, plus, slim ...) əvvəlcə məhz əsas modeli qoy, variantları sonra. Variant göstərilibsə, yalnız o variant.
Kateqoriya güclü siqnaldır: məsələn "Ehtiyat hissələri", "Oyuncaqlar", "Xidmətlər" kateqoriyasındakı elan, sorğu bunu istəmirsə, demək olar ki, həmişə atılmalıdır.
Şübhəli elanı at — az və dəqiq nəticə, çox və qarışıq nəticədən yaxşıdır.`;

const SCHEMA = {
  type: 'object',
  properties: {
    keep: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Saxlanılan elanların nömrələri, ən uyğundan başlayaraq',
    },
  },
  required: ['keep'],
  additionalProperties: false,
} as const;

/**
 * Namizədlərdən uyğun olanları seçib sıralayır. Uğursuz olarsa null.
 */
export async function aiRankResults(q: string, items: WebResult[]): Promise<WebResult[] | null> {
  const ai = getClient();
  if (!ai || !items.length) return null;
  const cand = items.slice(0, MAX_CANDIDATES);
  const lines = cand.map((r, i) => {
    const price = r.price != null ? `${r.price} ${r.currency || 'AZN'}` : 'qiymət yoxdur';
    return `${i}. ${r.title.replace(/\s+/g, ' ').slice(0, 140)} | kateqoriya: ${r.category || 'naməlum'} | ${price} | ${r.site}`;
  }).join('\n');

  try {
    const params: any = {
      model: RANK_MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      // Sadə təsnifat işi — aşağı effort kifayətdir və gecikməni azaldır.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `Sorğu: "${q}"\n\nNamizədlər:\n${lines}` }],
    };
    // Opus 5.5 üçün server tərəfli ehtiyat model (nadir imtina halında sorğu itməsin).
    if (RANK_MODEL === 'claude-opus-5-5') {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = [{ model: 'claude-opus-4-8' }];
    }
    const res: any = await ai.beta.messages.create(params);
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      console.warn('[searchRank] cavab alınmadı:', res.stop_reason);
      return null;
    }
    const text = (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.keep)) return null;
    const seen = new Set<number>();
    const out: WebResult[] = [];
    for (const n of parsed.keep) {
      if (!Number.isInteger(n) || n < 0 || n >= cand.length || seen.has(n)) continue;
      seen.add(n);
      out.push(cand[n]);
    }
    console.log('[searchRank] sorğu:', q, '| namizəd:', cand.length, '| saxlanılan:', out.length, '| model:', res.model);
    return out;
  } catch (e: any) {
    if (e instanceof Anthropic.RateLimitError) console.error('[searchRank] limit (429)');
    else if (e instanceof Anthropic.APIError) console.error('[searchRank] API xəta', e.status, e.message?.slice(0, 200));
    else console.error('[searchRank] xəta:', e?.name, e?.message);
    return null;
  }
}
