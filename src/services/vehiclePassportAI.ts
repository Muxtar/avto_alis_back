// Azərbaycan texniki pasportu üçün hibrid pasport oxuma servisi.
//
// İki mərhələli pipeline:
//   1) LOCAL OCR (tesseract.js + regex parser) — pulsuz, internetsiz işləyir.
//      Şəkil keyfiyyəti yaxşıdırsa kifayət qədər sahə oxuyur.
//   2) AI fallback (OpenAI vision) — yalnız OCR yetəri qədər sahə oxumadıqda
//      və OPENAI_API_KEY env-i təyin olunduqda işə düşür.
//
// OPENAI_API_KEY yoxdursa, sistem TAM OFFLINE işləyir — yalnız Tesseract.
// DeepSeek-dən tamamilə müstəqildir.

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { extractWithOCR, OCRFields } from './passportOCR';

export interface VehiclePassportFields {
  // Ön hissə
  registrationNumber: string | null; // A
  registrationDate: string | null;   // B.1
  manufactureYear: number | null;    // B.2
  ownerName: string | null;          // C.1
  ownerAddress: string | null;       // C.2
  ownershipType: string | null;      // C.3
  validUntil: string | null;         // H
  cardSerial: string | null;

  // Arxa hissə
  brand: string | null;              // D
  model: string | null;              // D.2
  vehicleType: string | null;        // D.3
  engineNumber: string | null;       // E.1
  bodyNumber: string | null;         // E.2 (VIN)
  chassisNumber: string | null;      // E.3
  color: string | null;              // E.4
  maxMass: string | null;            // F.1
  unloadedMass: string | null;       // F.2
  seatCount: number | null;          // F.3
  engineCapacity: string | null;     // G
  issuedBy: string | null;
  specialMarks: string | null;
}

export interface PassportExtractionResult {
  ok: boolean;
  fields: VehiclePassportFields;
  raw: unknown; // model-in qaytardığı xam json (audit üçün)
  error?: string;
}

const EMPTY_FIELDS: VehiclePassportFields = {
  registrationNumber: null,
  registrationDate: null,
  manufactureYear: null,
  ownerName: null,
  ownerAddress: null,
  ownershipType: null,
  validUntil: null,
  cardSerial: null,
  brand: null,
  model: null,
  vehicleType: null,
  engineNumber: null,
  bodyNumber: null,
  chassisNumber: null,
  color: null,
  maxMass: null,
  unloadedMass: null,
  seatCount: null,
  engineCapacity: null,
  issuedBy: null,
  specialMarks: null,
};

const PASSPORT_PROMPT = `Sən Azərbaycan Respublikasının "NƏQLİYYAT VASİTƏSİNİN QEYDİYYAT ŞƏHADƏTNAMƏSİ" (texniki pasport) kartını oxuyan dəqiq bir OCR mütəxəssisisən.

İki şəkil verilir: birincisi pasportun ÖN hissəsi, ikincisi ARXA hissəsi. Şəkillərin istiqaməti yan, baş aşağı və ya tərs ola bilər — mətni hər istiqamətdə oxu.

Sənin vəzifən sahələri kart üzərindəki nişanlamaya görə (A, B.1, B.2, C.1, C.2, C.3, D, D.2, D.3, E.1, E.2, E.3, E.4, F.1, F.2, F.3, G, H) çıxarmaq və yalnız aşağıdakı JSON-u qaytarmaqdır. Heç bir izahat, markdown və ya əlavə mətn YAZMA.

Cavab sxemi:
{
  "registrationNumber": "A — qeydiyyat nişanı, məs: 77NP518",
  "registrationDate": "B.1 — qeydiyyat tarixi (DD.MM.YYYY)",
  "manufactureYear": 2019,
  "ownerName": "C.1 — mülkiyyətçinin tam adı",
  "ownerAddress": "C.2 — sahibinin ünvanı (kart üzərində yazıldığı kimi)",
  "ownershipType": "C.3 — Fiziki şəxs / Hüquqi şəxs",
  "validUntil": "H — etibarlıdır (boş ola bilər)",
  "cardSerial": "kart üzərindəki seriya nömrəsi, məs: BB667834",
  "brand": "D — marka, məs: BMW",
  "model": "D.2 — model, məs: X7 XDRIVE 40i",
  "vehicleType": "D.3 — tip, məs: MİNİK, UNIVERSAL",
  "engineNumber": "E.1 — mühərrik nömrəsi",
  "bodyNumber": "E.2 — ban / VIN nömrəsi",
  "chassisNumber": "E.3 — şassi nömrəsi",
  "color": "E.4 — rəngi (məs: Ag, Qara)",
  "maxMass": "F.1 — maksimal kütlə",
  "unloadedMass": "F.2 — yüksüz kütlə",
  "seatCount": 5,
  "engineCapacity": "G — mühərrikin həcmi (sm³)",
  "issuedBy": "Verilib — orqan",
  "specialMarks": "Xüsusi qeydlər"
}

QAYDALAR:
- Hər hansı sahəni oxuya bilmirsənsə, dəyəri null qoy (boş sətir DEYİL).
- "manufactureYear" və "seatCount" rəqəm (int) olmalıdır, yoxdursa null.
- Mətni kart üzərindəki orijinal yazılışla saxla (MAJUSKUL/minuskül və "Ə, Ş, Ç, Ö, Ü, Ğ, İ" hərfləri olduğu kimi).
- Cavabı YALNIZ JSON kimi qaytar. Markdown code block (\`\`\`) İŞLƏTMƏ.`;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log('[vehiclePassportAI] OPENAI_API_KEY yoxdur — yalnız local Tesseract OCR işləyəcək (offline rejim).');
}

const client = apiKey
  ? new OpenAI({ apiKey, timeout: 30000, maxRetries: 1 })
  : null;

const MODEL = process.env.PASSPORT_VISION_MODEL || 'gpt-4o-mini';

function fileToDataUrl(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'jpeg';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}

function coerce(raw: unknown): VehiclePassportFields {
  const f: VehiclePassportFields = { ...EMPTY_FIELDS };
  if (!raw || typeof raw !== 'object') return f;
  const r = raw as Record<string, unknown>;

  const str = (k: keyof VehiclePassportFields) => {
    const v = r[k];
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };
  const num = (k: keyof VehiclePassportFields) => {
    const v = r[k];
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };

  f.registrationNumber = str('registrationNumber');
  f.registrationDate = str('registrationDate');
  f.manufactureYear = num('manufactureYear');
  f.ownerName = str('ownerName');
  f.ownerAddress = str('ownerAddress');
  f.ownershipType = str('ownershipType');
  f.validUntil = str('validUntil');
  f.cardSerial = str('cardSerial');
  f.brand = str('brand');
  f.model = str('model');
  f.vehicleType = str('vehicleType');
  f.engineNumber = str('engineNumber');
  f.bodyNumber = str('bodyNumber');
  f.chassisNumber = str('chassisNumber');
  f.color = str('color');
  f.maxMass = str('maxMass');
  f.unloadedMass = str('unloadedMass');
  f.seatCount = num('seatCount');
  f.engineCapacity = str('engineCapacity');
  f.issuedBy = str('issuedBy');
  f.specialMarks = str('specialMarks');
  return f;
}

function ocrFieldsToVehicleFields(ocr: OCRFields): VehiclePassportFields {
  return {
    registrationNumber: ocr.registrationNumber ?? null,
    registrationDate: ocr.registrationDate ?? null,
    manufactureYear: ocr.manufactureYear ?? null,
    ownerName: ocr.ownerName ?? null,
    ownerAddress: ocr.ownerAddress ?? null,
    ownershipType: ocr.ownershipType ?? null,
    validUntil: ocr.validUntil ?? null,
    cardSerial: ocr.cardSerial ?? null,
    brand: ocr.brand ?? null,
    model: ocr.model ?? null,
    vehicleType: ocr.vehicleType ?? null,
    engineNumber: ocr.engineNumber ?? null,
    bodyNumber: ocr.bodyNumber ?? null,
    chassisNumber: ocr.chassisNumber ?? null,
    color: ocr.color ?? null,
    maxMass: ocr.maxMass ?? null,
    unloadedMass: ocr.unloadedMass ?? null,
    seatCount: ocr.seatCount ?? null,
    engineCapacity: ocr.engineCapacity ?? null,
    issuedBy: ocr.issuedBy ?? null,
    specialMarks: ocr.specialMarks ?? null,
  };
}

// AI nəticəsi ilə OCR nəticəsini birləşdir: AI-da boş olan sahələri OCR-dakı
// dəyərlərlə doldur (AI prioritetlidir, çünki vision modeli kontekst başa düşür).
function mergeFields(primary: VehiclePassportFields, secondary: VehiclePassportFields): VehiclePassportFields {
  const out: VehiclePassportFields = { ...primary };
  for (const k of Object.keys(out) as (keyof VehiclePassportFields)[]) {
    if (out[k] === null || out[k] === undefined || out[k] === '') {
      (out as any)[k] = secondary[k];
    }
  }
  return out;
}

async function callOpenAIVision(
  frontPath: string,
  backPath: string,
): Promise<{ ok: boolean; fields: VehiclePassportFields; raw: unknown; error?: string }> {
  if (!client) {
    return {
      ok: false,
      fields: { ...EMPTY_FIELDS },
      raw: null,
      error: 'OPENAI_API_KEY təyin edilməyib',
    };
  }
  let frontUrl: string;
  let backUrl: string;
  try {
    frontUrl = fileToDataUrl(frontPath);
    backUrl = fileToDataUrl(backPath);
  } catch (err: any) {
    return {
      ok: false,
      fields: { ...EMPTY_FIELDS },
      raw: null,
      error: `Şəkil oxuna bilmədi: ${err?.message || 'naməlum xəta'}`,
    };
  }
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: PASSPORT_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Birinci şəkil — pasportun ÖN hissəsi.' },
            { type: 'image_url', image_url: { url: frontUrl } },
            { type: 'text', text: 'İkinci şəkil — pasportun ARXA hissəsi.' },
            { type: 'image_url', image_url: { url: backUrl } },
            { type: 'text', text: 'İkisini birləşdirib təlimatdakı sxemə uyğun JSON qaytar.' },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });
    const content = response.choices[0]?.message?.content || '{}';
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, fields: { ...EMPTY_FIELDS }, raw: content, error: 'AI cavabı JSON kimi parse edilə bilmədi' };
    }
    return { ok: true, fields: coerce(parsed), raw: parsed };
  } catch (err: any) {
    console.error('[vehiclePassportAI] OpenAI çağırışı uğursuz oldu:', err?.message);
    return { ok: false, fields: { ...EMPTY_FIELDS }, raw: null, error: 'AI servisi cavab vermədi' };
  }
}

export async function extractPassportFromFiles(
  frontPath: string,
  backPath: string,
): Promise<PassportExtractionResult> {
  // STEP 1: Local OCR (tesseract.js)
  const ocr = await extractWithOCR(frontPath, backPath);
  const ocrFields = ocrFieldsToVehicleFields(ocr.fields);

  // OCR yetəri qədər oxudusa, AI çağırmadan qaytar (pulsuz yol)
  if (ocr.ok) {
    return {
      ok: true,
      fields: ocrFields,
      raw: { source: 'tesseract', filledCount: ocr.filledCount, fields: ocr.fields, text: ocr.rawText },
    };
  }

  // STEP 2: OCR zəif oxudu — OpenAI vision-a fallback
  if (!client) {
    // AI yoxdursa, OCR nəticəsini olduğu kimi qaytar (kullanıcı sahələri əllə doldura bilər)
    return {
      ok: ocr.filledCount > 0,
      fields: ocrFields,
      raw: { source: 'tesseract', filledCount: ocr.filledCount, fields: ocr.fields, text: ocr.rawText },
      error:
        ocr.filledCount > 0
          ? 'OCR az sahə oxudu. Sahələri əllə yoxlayıb düzəldin və ya daha aydın şəkil yükləyin.'
          : 'OCR şəkilləri oxuya bilmədi. Daha aydın şəkil yükləyin və ya sahələri əllə doldurun.',
    };
  }

  const ai = await callOpenAIVision(frontPath, backPath);
  if (!ai.ok) {
    // AI də uğursuz oldu — OCR qismi nəticəsini istifadə et
    return {
      ok: ocr.filledCount > 0,
      fields: ocrFields,
      raw: { source: 'tesseract+ai-failed', ocr: ocr.fields, aiError: ai.error, text: ocr.rawText },
      error: ai.error,
    };
  }
  // AI uğurla bitdi — AI nəticəsini OCR ilə tamamla (AI bəzən bir sahəni atlaya bilər,
  // OCR onu tutmuşsa, doldur).
  return {
    ok: true,
    fields: mergeFields(ai.fields, ocrFields),
    raw: { source: 'openai+tesseract', ai: ai.raw, ocr: ocr.fields },
  };
}
