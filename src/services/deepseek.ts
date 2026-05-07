import OpenAI from 'openai';

if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('WARNING: DEEPSEEK_API_KEY is not set. AI analysis will use fallback keyword extraction.');
}

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy',
  baseURL: 'https://api.deepseek.com',
  timeout: 15000, // 15 saniye timeout
  maxRetries: 1,  // 1 kere tekrar dene
});

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

const ANALYSIS_PROMPT = `Sən avtomobil ehtiyat hissələri üzrə mütəxəssissən. İstifadəçinin sorğusunu analiz et və JSON formatında cavab ver.

Cavab formatı (YALNIZ JSON, başqa heç nə yazma):
{
  "productType": "məhsulun tipi (məs: təkər, fren balatası, yağ filtri, lampa)",
  "brand": "hissənin brendi (məs: Bosch, Brembo) və ya null",
  "vehicleBrand": "avtomobil markası (məs: Toyota, BMW) və ya null",
  "vehicleModel": "avtomobil modeli (məs: RAV4, X5) və ya null",
  "vehicleYear": "il (məs: 2018) və ya null",
  "category": "kateqoriya (Motor, Elektrik, Kuzov, Təkər, Əyləc, İnteryер, Yağ/Filtr, Digər)",
  "specifications": ["ölçü, tip və s. (məs: 18 düym, R18, 225/60R18)"],
  "keywords": ["axtarış üçün açar sözlər"],
  "summary": "Azərbaycan dilində qısa xülasə - nə axtarır"
}`;

// Chat mesajini siniflandir: inquiry mi yoksa sohbet mi?
export interface ChatResponse {
  type: 'inquiry' | 'chat';
  reply: string; // sohbet cevabi (type=chat ise)
  analysis?: AIAnalysis; // inquiry analizi (type=inquiry ise)
}

const CHAT_PROMPT = `Sən AvtoBazar platformasının köməkçisisən. Avtomobil ehtiyat hissələri, mexanik xidmətləri və avtomobil bazarı ilə bağlı sualları cavabla.

ÖNƏMLİ QAYDA: İstifadəçinin mesajını analiz et və JSON formatında cavab ver.

Əgər istifadəçi avtomobil ehtiyat hissəsi, yedək parça, mexanik xidməti və ya avtomobillə bağlı bir şey AXTARIRSA/İSTƏYİRSƏ:
{"type": "inquiry", "reply": ""}

Əgər istifadəçi sadəcə söhbət edirsə, salam deyirsə, sual verirsə və ya mövzu ilə əlaqəsiz bir şey yazırsa:
{"type": "chat", "reply": "Cavabınız burada - istifadəçinin dilində cavab verin. Mövzu ilə əlaqəsiz suallar üçün istifadəçini avtomobil ehtiyat hissələri axtarmağa yönləndirin."}

Nümunələr:
- "salam necəsən?" → {"type": "chat", "reply": "Salam! Yaxşıyam, sağ olun! Mən AvtoBazar köməkçisiyəm. Sizə avtomobil ehtiyat hissələri tapmaqda kömək edə bilərəm. Nə axtarırsınız?"}
- "BMW X5 fren balatası lazımdır" → {"type": "inquiry", "reply": ""}
- "hava necədir?" → {"type": "chat", "reply": "Mən yalnız avtomobil ehtiyat hissələri ilə bağlı kömək edə bilərəm. Hansı hissəni axtarırsınız?"}
- "привет" → {"type": "chat", "reply": "Здравствуйте! Я помощник AvtoBazar. Чем могу помочь? Какую автозапчасть вы ищете?"}
- "hello" → {"type": "chat", "reply": "Hello! I'm the AvtoBazar assistant. I can help you find car parts. What are you looking for?"}
- "mənə RAV4 üçün təkər lazımdır" → {"type": "inquiry", "reply": ""}
- "nə sata bilərsiniz?" → {"type": "chat", "reply": "AvtoBazar-da avtomobil ehtiyat hissələri, mexanik xidmətləri və müxtəlif avtomobil aksesuarları tapa bilərsiniz. Konkret nə axtarırsınız?"}

YALNIZ JSON cavab ver, başqa heç nə yazma.`;

export async function chatMessage(text: string): Promise<ChatResponse> {
  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: CHAT_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.3,
    });

    const content = response.choices[0].message.content || '{}';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    return {
      type: parsed.type === 'inquiry' ? 'inquiry' : 'chat',
      reply: parsed.reply || '',
    };
  } catch {
    return { type: 'chat', reply: 'Xəta baş verdi. Yenidən cəhd edin.' };
  }
}

// Vision-based analysis. Sends a base64 image to a vision-capable model and
// extracts the same AIAnalysis structure as text-based requests.
// DeepSeek's text-only `deepseek-chat` model doesn't accept images, so this
// uses OpenAI's `gpt-4o-mini` if OPENAI_API_KEY is set; otherwise returns
// a generic fallback so the rest of the search flow keeps working.
const visionClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 1 })
  : null;

export async function analyzeImage(imageBase64: string, mimeType: string): Promise<AIAnalysis> {
  if (!visionClient) {
    return {
      productType: null, brand: null, vehicleBrand: null, vehicleModel: null,
      vehicleYear: null, category: null, specifications: [], keywords: [],
      summary: 'Şəkilli axtarış üçün vision modeli konfiqurasiya edilməyib. OPENAI_API_KEY env-i təyin edin.',
    };
  }
  try {
    const response = await visionClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Bu şəkildəki avtomobil ehtiyat hissəsini analiz et və JSON qaytar.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });
    const content = response.choices[0].message.content || '{}';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err: any) {
    // H25 fix: do NOT leak raw provider error message (may contain API key
    // metadata, internal hostnames, etc.). Log internally, return generic msg.
    console.error('[analyzeImage] vision API failed:', err?.message);
    return {
      productType: null, brand: null, vehicleBrand: null, vehicleModel: null,
      vehicleYear: null, category: null, specifications: [],
      keywords: [], summary: 'Şəkilli axtarış uğursuz oldu. Yenidən cəhd edin və ya mətnlə axtarın.',
    };
  }
}

export async function analyzeRequest(text: string): Promise<AIAnalysis> {
  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    });

    const content = response.choices[0].message.content || '{}';
    // JSON parse - bazen markdown code block icinde olabilir
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (error) {
    // AI calismazsa basit keyword extraction yap
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return {
      productType: null,
      brand: null,
      vehicleBrand: null,
      vehicleModel: null,
      vehicleYear: null,
      category: null,
      specifications: [],
      keywords: words,
      summary: text,
    };
  }
}
