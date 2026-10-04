// Azərbaycan texniki pasportunu oxuma servisi.
//
// Əsas yol: Claude (vision) — aşağıda `extractWithClaude`. Açar yoxdursa, admin
// söndürübsə və ya sorğu alınmasa EHTİYAT yol: tam lokal OCR (`tesseract.js` +
// `sharp`), xarici API-siz.
//
// Lokal OCR haqqında:
// Strategiya: hər şəkili 4 fərqli ön emal variantında oxuyub bütün mətnləri
// birləşdiririk, sonra parser hər sahə üçün ən yaxşı namizədi seçir. Multi-pass
// yanaşması tək bir pass-də zəif çıxan VIN, mühərrik nömrəsi kimi çətin sahələri
// tutmağa kömək edir.

import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { resolveFlag } from './settings';
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
  raw: unknown;
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

// ── CLAUDE İLƏ OXUNUŞ ────────────────────────────────────────────────────────
// Tesseract texpasportun kiçik şriftini, VIN-i və fotodakı əyriliyi zəif oxuyur.
// Açar varsa və admin söndürməyibsə sənədi Claude (vision) oxuyur; alınmasa
// köhnə lokal OCR ehtiyat kimi qalır. Model kimlik/sənəd AI-ı ilə eynidir.
const AI_MODEL = process.env.CREDENTIAL_AI_MODEL || 'claude-opus-4-8';
let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

async function imageBlock(path: string): Promise<any> {
  const buf = await fs.promises.readFile(path);
  // Format fayl adından yox, məzmundan təyin olunur (yüklənən şəkil emaldan keçir).
  const media = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
    : buf.slice(0, 4).toString('ascii') === 'RIFF' ? 'image/webp'
    : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
}

const AI_PROMPT = `Bu, Azərbaycan Respublikasında verilmiş nəqliyyat vasitəsinin qeydiyyat şəhadətnaməsinin (texniki pasportun) şəkli/şəkilləridir. Üzərindəki məlumatı oxu.
YALNIZ bu JSON formatında cavab ver (başqa heç nə yazma, oxunmayan sahəni null qoy, heç nəyi uydurma):
{
  "isVehiclePassport": true,
  "registrationNumber": "A — dövlət qeydiyyat nişanı, boşluqsuz və tiresiz, məs. 77NP518",
  "registrationDate": "B.1 — qeydiyyat tarixi GG.AA.İİİİ",
  "manufactureYear": 2015,
  "ownerName": "C.1 — mülkiyyətçi",
  "ownerAddress": "C.2 — ünvan",
  "ownershipType": "C.3 — mülkiyyət növü",
  "validUntil": "H — etibarlıdır",
  "cardSerial": "kartın seriya və nömrəsi, məs. BB667834",
  "brand": "D.1 — marka, məs. MERCEDES-BENZ",
  "model": "D.2 — model, məs. E 220",
  "vehicleType": "D.3 — tip",
  "engineNumber": "E.1 — mühərrik nömrəsi",
  "bodyNumber": "E.2 — ban nömrəsi (VIN), 17 simvol, boşluqsuz",
  "chassisNumber": "E.3 — şassi nömrəsi",
  "color": "E.4 — rəng",
  "maxMass": "F.1", "unloadedMass": "F.2", "seatCount": 5,
  "engineCapacity": "G — mühərrikin həcmi (sm³)",
  "issuedBy": "verən orqan",
  "specialMarks": "xüsusi qeydlər"
}
Qaydalar: VIN-də I, O, Q hərfləri olmur — oxşar simvolu 1 və ya 0 kimi oxu. Şəkil texniki pasport deyilsə "isVehiclePassport": false yaz və qalan sahələri null qoy.`;

async function extractWithClaude(paths: string[]): Promise<PassportExtractionResult | null> {
  const ai = getClient();
  if (!ai || !paths.length) return null;
  if (!(await resolveFlag('ai_vehicle_passport'))) return null;
  try {
    const blocks = await Promise.all(paths.map(imageBlock));
    const res = await ai.messages.create({
      model: AI_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: AI_PROMPT }] }],
    });
    const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const brace = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(fence ? fence[1].trim() : brace ? brace[0] : text);
    if (parsed?.isVehiclePassport === false) {
      return { ok: false, fields: { ...EMPTY_FIELDS }, raw: { source: 'claude', parsed }, error: 'Bu şəkil texniki pasporta oxşamır. Sənədin özünü aydın çəkin və ya sahələri əl ilə yazın.' };
    }
    const str = (v: any) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
    const num = (v: any) => { const n = typeof v === 'number' ? v : parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };
    const compact = (v: any) => { const s = str(v); return s ? s.replace(/[\s-]/g, '').toUpperCase() : null; };
    const year = num(parsed.manufactureYear);
    const fields: VehiclePassportFields = {
      registrationNumber: compact(parsed.registrationNumber),
      registrationDate: str(parsed.registrationDate),
      manufactureYear: year && year >= 1900 && year <= new Date().getFullYear() + 1 ? year : null,
      ownerName: str(parsed.ownerName),
      ownerAddress: str(parsed.ownerAddress),
      ownershipType: str(parsed.ownershipType),
      validUntil: str(parsed.validUntil),
      cardSerial: compact(parsed.cardSerial),
      brand: str(parsed.brand),
      model: str(parsed.model),
      vehicleType: str(parsed.vehicleType),
      engineNumber: str(parsed.engineNumber),
      bodyNumber: compact(parsed.bodyNumber),
      chassisNumber: str(parsed.chassisNumber),
      color: str(parsed.color),
      maxMass: str(parsed.maxMass),
      unloadedMass: str(parsed.unloadedMass),
      seatCount: num(parsed.seatCount),
      engineCapacity: str(parsed.engineCapacity),
      issuedBy: str(parsed.issuedBy),
      specialMarks: str(parsed.specialMarks),
    };
    // Əsas sahələr: formada istifadəçidən istənənlər.
    const core = [fields.brand, fields.model, fields.manufactureYear, fields.registrationNumber, fields.bodyNumber];
    const got = core.filter((x) => x !== null).length;
    if (got === 0) return { ok: false, fields, raw: { source: 'claude', parsed }, error: 'Sənəddən məlumat oxunmadı. Şəkli daha aydın çəkin və ya sahələri əl ilə yazın.' };
    return {
      ok: got === core.length,
      fields,
      raw: { source: 'claude', parsed },
      error: got === core.length ? undefined : 'Bəzi sahələr oxunmadı (sənədin o biri üzü lazım ola bilər). Çatışmayanları əl ilə yazın.',
    };
  } catch (e: any) {
    console.error('[vehiclePassportAI] claude:', e?.message);
    return null;   // lokal OCR-a keç
  }
}

/**
 * Texpasportun bir və ya hər iki üzünü oxuyur. Tək şəkil də qəbul olunur:
 * ön üzdə dövlət nişanı və il, arxa üzdə marka, model və ban nömrəsi olur.
 */
export async function extractPassportFromFiles(
  frontPath: string | null,
  backPath: string | null,
): Promise<PassportExtractionResult> {
  const paths = [frontPath, backPath].filter((p): p is string => !!p);
  const viaAI = await extractWithClaude(paths);
  if (viaAI) return viaAI;

  // Ehtiyat: lokal OCR (yalnız hər iki üz olanda işləyir).
  if (!frontPath || !backPath) {
    return { ok: false, fields: { ...EMPTY_FIELDS }, raw: { source: 'none' }, error: 'Sənəd avtomatik oxunmadı. Sahələri əl ilə yazın və ya sənədin hər iki üzünü yükləyin.' };
  }
  const ocr = await extractWithOCR(frontPath, backPath);
  const fields = ocrFieldsToVehicleFields(ocr.fields);

  if (ocr.filledCount === 0) {
    return {
      ok: false,
      fields: { ...EMPTY_FIELDS },
      raw: { source: 'tesseract', text: ocr.rawText },
      error: 'OCR şəkilləri oxuya bilmədi. Şəkilləri düz tutub yenidən cəhd edin və ya sahələri əllə doldurun.',
    };
  }

  return {
    ok: ocr.ok,
    fields,
    raw: { source: 'tesseract', filledCount: ocr.filledCount, fields: ocr.fields, text: ocr.rawText },
    error: ocr.ok
      ? undefined
      : 'Bəzi sahələr oxunmadı. Sahələri yoxlayın və lazım olanları əllə düzəldin.',
  };
}
