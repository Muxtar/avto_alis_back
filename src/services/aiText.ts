// Mətn + şəkil AI analizi — CLAUDE (Anthropic) ilə. (Əvvəl DeepSeek/OpenAI idi; tamamilə çıxarıldı.)
// Funksiyalar: chatMessage (söhbət/inquiry təsnifatı), analyzeRequest (mətn analizi),
// analyzeImage (şəkil analizi — Claude vision).
//
// Açar ANTHROPIC_API_KEY env-dən oxunur. Model AI_TEXT_MODEL ilə dəyişilir
// (default claude-opus-4-8 — bu hesabda sübut olunmuş işləyən model).

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AI_TEXT_MODEL || 'claude-opus-4-8';

let client: Anthropic | null = null;
function ai(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export interface AIAnalysis {
  productType: string | null;
  brand: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  category: string | null;
  specifications: string[];
  keywords: string[];
  summary: string;
}

export interface ChatResponse {
  type: 'inquiry' | 'chat';
  reply: string;
  analysis?: AIAnalysis;
}

const ANALYSIS_PROMPT = `Sən ümumi bazar üzrə mütəxəssissən. İstifadəçinin sorğusunu analiz et və JSON formatında cavab ver.

Cavab formatı (YALNIZ JSON, başqa heç nə yazma):
{
  "productType": "məhsulun tipi",
  "brand": "brend və ya null",
  "vehicleBrand": "avtomobil markası və ya null",
  "vehicleModel": "avtomobil modeli və ya null",
  "vehicleYear": "il (rəqəm) və ya null",
  "category": "kateqoriya",
  "specifications": ["ölçü, tip və s."],
  "keywords": ["axtarış üçün açar sözlər"],
  "summary": "Azərbaycan dilində qısa xülasə - nə axtarır"
}`;

const CHAT_PROMPT = `Sən tradixai onlayn bazar platformasının köməkçisisən. tradixai hər şeyin alınıb-satıldığı ümumi bazardır: elektronika, geyim, daşınmaz əmlak, məişət texnikası, nəqliyyat, ev əşyaları, uşaq malları, müxtəlif xidmətlər və s.

ÖNƏMLİ QAYDA: İstifadəçinin mesajını analiz et və JSON formatında cavab ver.

Əgər istifadəçi hər hansı məhsul və ya xidmət AXTARIRSA/İSTƏYİRSƏ (almaq, tapmaq, lazımdır):
{"type": "inquiry", "reply": ""}

Əgər istifadəçi sadəcə söhbət edirsə, salam deyirsə, sual verirsə:
{"type": "chat", "reply": "Cavabınız - istifadəçinin dilində. Əlaqəsiz suallarda istifadəçini lazım olan məhsul/xidməti yazmağa yönləndirin."}

Nümunələr:
- "salam necəsən?" → {"type": "chat", "reply": "Salam! Yaxşıyam, sağ olun! Mən tradixai köməkçisiyəm. Axtardığınız məhsul və ya xidməti tapmaqda kömək edə bilərəm. Nə lazımdır?"}
- "iPhone 14 lazımdır" → {"type": "inquiry", "reply": ""}
- "2 otaqlı mənzil axtarıram" → {"type": "inquiry", "reply": ""}
- "hello" → {"type": "chat", "reply": "Hello! I'm the tradixai assistant. What are you looking for?"}

YALNIZ JSON cavab ver, başqa heç nə yazma.`;

// Claude cavabından mətni çıxar.
function textOf(resp: Anthropic.Message): string {
  return resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
}
// Mətndən JSON çıxar (model bəzən ```json ... ``` ilə bükür).
function parseJson(content: string): any {
  const s = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(s);
}

export async function chatMessage(text: string): Promise<ChatResponse> {
  const c = ai();
  if (!c) return { type: 'chat', reply: 'AI hazırda əlçatan deyil.' };
  try {
    const resp = await c.messages.create({ model: MODEL, max_tokens: 400, system: CHAT_PROMPT, messages: [{ role: 'user', content: text }] });
    const parsed = parseJson(textOf(resp) || '{}');
    return { type: parsed.type === 'inquiry' ? 'inquiry' : 'chat', reply: parsed.reply || '' };
  } catch (e: any) {
    console.error('[aiText.chatMessage]', e?.message);
    return { type: 'chat', reply: 'Xəta baş verdi. Yenidən cəhd edin.' };
  }
}

export async function analyzeRequest(text: string): Promise<AIAnalysis> {
  const c = ai();
  if (c) {
    try {
      const resp = await c.messages.create({ model: MODEL, max_tokens: 500, system: ANALYSIS_PROMPT, messages: [{ role: 'user', content: text }] });
      return parseJson(textOf(resp) || '{}');
    } catch (e: any) { console.error('[aiText.analyzeRequest]', e?.message); }
  }
  // Fallback — sadə açar söz çıxarma.
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return { productType: null, brand: null, vehicleBrand: null, vehicleModel: null, vehicleYear: null, category: null, specifications: [], keywords: words, summary: text };
}

export async function analyzeImage(imageBase64: string, mimeType: string): Promise<AIAnalysis> {
  const c = ai();
  const empty = (summary: string): AIAnalysis => ({ productType: null, brand: null, vehicleBrand: null, vehicleModel: null, vehicleYear: null, category: null, specifications: [], keywords: [], summary });
  if (!c) return empty('Şəkilli axtarış üçün AI konfiqurasiya edilməyib.');
  // Claude yalnız bu media tiplərini qəbul edir.
  const media = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg';
  try {
    const resp = await c.messages.create({
      model: MODEL, max_tokens: 500, system: ANALYSIS_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: media as any, data: imageBase64 } },
        { type: 'text', text: 'Bu şəkildəki məhsulu analiz et və YALNIZ JSON qaytar.' },
      ] }],
    });
    return parseJson(textOf(resp) || '{}');
  } catch (err: any) {
    console.error('[aiText.analyzeImage]', err?.message);
    return empty('Şəkilli axtarış uğursuz oldu. Yenidən cəhd edin və ya mətnlə axtarın.');
  }
}
