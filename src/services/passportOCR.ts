// Local OCR: tesseract.js + sharp ilə Azərbaycan texniki pasportunu oxuyur.
// Heç bir xarici API yoxdur, tam offline işləyir.
//
// Strategiya — MULTI-PASS:
//   Pass A) Standart: rəngli orijinal + sharpen
//   Pass B) Yüksək kontrast boz: holoqram naxışını yox edir
//   Pass C) Threshold (binarize): mətn qara/ağ — VIN üçün ən yaxşı
//   Pass D) Alfanumeric whitelist: yalnız rəqəmlər və BÖYÜK Latın hərfləri
//           (VIN, mühərrik nömrəsi, qeydiyyat nömrəsi üçün — fon naxışından
//            təsadüfən tutulan simvolları kənarlaşdırır)
//
// Bütün passların mətni birləşdirilir, parser hər sahənin ən yaxşı namizədini
// regex və xüsusi qaydalarla seçir.

import { createWorker, Worker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';

// İki worker: biri normal mətn üçün (aze+eng), digəri alfanumeric whitelist
// üçün (yalnız eng + char_whitelist). İlk istifadədə yaradılır, sonra cache.
let normalWorker: Promise<Worker> | null = null;
let alphaNumWorker: Promise<Worker> | null = null;

function getNormalWorker(): Promise<Worker> {
  if (!normalWorker) {
    normalWorker = createWorker(['aze', 'eng']);
  }
  return normalWorker;
}

async function getAlphaNumWorker(): Promise<Worker> {
  if (!alphaNumWorker) {
    alphaNumWorker = createWorker('eng').then(async (w) => {
      await w.setParameters({
        // VIN və qeydiyyat nömrələri üçün — yalnız böyük hərflər və rəqəmlər
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- ',
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      });
      return w;
    });
  }
  return alphaNumWorker;
}

// === ÖN EMAL VARIANTLARI ===

async function preprocessNormal(imagePath: string): Promise<Buffer> {
  // Standart: rəngli, sharpen — ümumi mətn üçün
  return sharp(imagePath, { limitInputPixels: 50_000_000 })
    .rotate() // EXIF
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .normalise()
    .sharpen({ sigma: 1.0 })
    .toFormat('png')
    .toBuffer();
}

async function preprocessHighContrast(imagePath: string): Promise<Buffer> {
  // Yüksək kontrast boz: holoqram rəngləri yox olur, mətn qabardır
  return sharp(imagePath, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalise()
    .linear(1.4, -30) // kontrast +40%, parlaqlıq −30
    .sharpen({ sigma: 1.5, m1: 1, m2: 2 })
    .toFormat('png')
    .toBuffer();
}

async function preprocessThreshold(imagePath: string): Promise<Buffer> {
  // Binarized — mətn qara/ağ. VIN, plaka kimi sıxbulduqlu mətn üçün ideal.
  return sharp(imagePath, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalise()
    .median(1) // səs-küy azalt
    .threshold(135) // adaptive deyil amma sadədir
    .toFormat('png')
    .toBuffer();
}

async function preprocessForAlphaNum(imagePath: string): Promise<Buffer> {
  // VIN/qeydiyyat üçün — yüksək rezolyusiya + binarized + mild blur
  return sharp(imagePath, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalise()
    .sharpen({ sigma: 2.0, m1: 1, m2: 3 })
    .threshold(140)
    .toFormat('png')
    .toBuffer();
}

// === OCR ÇAĞIRIŞLARI ===

async function ocrText(imagePath: string, variant: 'normal' | 'highContrast' | 'threshold'): Promise<string> {
  const buffer = variant === 'normal'
    ? await preprocessNormal(imagePath)
    : variant === 'highContrast'
      ? await preprocessHighContrast(imagePath)
      : await preprocessThreshold(imagePath);
  const w = await getNormalWorker();
  const { data } = await w.recognize(buffer);
  return data.text || '';
}

async function ocrAlphaNum(imagePath: string): Promise<string> {
  const buffer = await preprocessForAlphaNum(imagePath);
  const w = await getAlphaNumWorker();
  const { data } = await w.recognize(buffer);
  return data.text || '';
}

// === SAHƏ ÇIXARMA ===

export interface OCRFields {
  registrationNumber?: string;
  registrationDate?: string;
  manufactureYear?: number;
  ownerName?: string;
  ownerAddress?: string;
  ownershipType?: string;
  validUntil?: string;
  cardSerial?: string;
  brand?: string;
  model?: string;
  vehicleType?: string;
  engineNumber?: string;
  bodyNumber?: string;
  chassisNumber?: string;
  color?: string;
  maxMass?: string;
  unloadedMass?: string;
  seatCount?: number;
  engineCapacity?: string;
  issuedBy?: string;
  specialMarks?: string;
}

const KNOWN_BRANDS = [
  'BMW', 'TOYOTA', 'MERCEDES-BENZ', 'MERCEDES', 'AUDI', 'LEXUS', 'HYUNDAI',
  'KIA', 'HONDA', 'FORD', 'CHEVROLET', 'LADA', 'PORSCHE', 'VOLKSWAGEN', 'VW',
  'NISSAN', 'MAZDA', 'VOLVO', 'MITSUBISHI', 'SUBARU', 'TESLA', 'RENAULT',
  'PEUGEOT', 'SKODA', 'SEAT', 'OPEL', 'INFINITI', 'ACURA', 'JEEP', 'DODGE',
  'CHRYSLER', 'CADILLAC', 'BUICK', 'GMC', 'LAND ROVER', 'JAGUAR', 'MINI',
  'GAZ', 'UAZ', 'ZAZ', 'GEELY', 'CHERY', 'HAVAL', 'GENESIS', 'CITROEN', 'FIAT',
];

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Bir mətndən sahələri çıxar. `alphaNumText` xüsusi alfanumeric pass-dan gəlir
// (VIN, qeydiyyat nömrəsi üçün üstünlüklü istifadə olunur).
export function parsePassportText(
  frontText: string,
  backText: string,
  frontAlpha = '',
  backAlpha = '',
): OCRFields {
  const all = `${frontText}\n${backText}`;
  const allAlpha = `${frontAlpha}\n${backAlpha}`;
  const fields: OCRFields = {};

  // === A — qeydiyyat nişanı ===
  // AlphaNum pass-də daha təmiz çıxır (rəqəm + 2 hərf + rəqəm formatı)
  const regCandidates = [
    ...allAlpha.matchAll(/\b(\d{2,3}\s?[A-Z]{2}\s?\d{3,4})\b/g),
    ...all.matchAll(/\b(\d{2,3}\s?[A-ZƏİ]{2}\s?\d{3,4})\b/g),
  ];
  if (regCandidates.length > 0) {
    fields.registrationNumber = regCandidates[0][1].replace(/\s/g, '');
  }

  // === B.1 — qeydiyyat tarixi (DD.MM.YYYY) ===
  const date = all.match(/\b([0-3]?\d\.[0-1]?\d\.(?:19|20)\d{2})\b/);
  if (date) fields.registrationDate = date[1];

  // === B.2 — istehsal ili ===
  // Tarixin ilindən fərqli, standalone 4-rəqəmli il (1980-2030)
  const yearTokens = [...all.matchAll(/\b((?:19[8-9]\d|20[0-3]\d))\b/g)].map((m) => parseInt(m[1], 10));
  const dateYear = date ? parseInt(date[1].split('.')[2], 10) : null;
  const distinctYears = yearTokens.filter((y) => y !== dateYear);
  if (distinctYears.length > 0) fields.manufactureYear = distinctYears[0];

  // === E.2 — VIN / Ban nömrəsi (17 simvol) ===
  // Üç mənbədən axtarırıq: alphaNum (ən etibarlı), arxa standart, hər ikisi.
  // 17-simvolluq alfa-rəqəm tokenləri sırala; I/O/Q olmayanı üstün tut.
  const vinCandidates = new Set<string>();
  for (const text of [backAlpha, allAlpha, backText, all]) {
    for (const m of text.matchAll(/\b([A-Z0-9]{16,18})\b/g)) {
      vinCandidates.add(m[1]);
    }
  }
  // Sırala: 17 simvolluq olanlar əvvəl, içində I/O/Q olmayanlar üstün
  const vinList = [...vinCandidates].sort((a, b) => {
    const lenDiff = Math.abs(17 - a.length) - Math.abs(17 - b.length);
    if (lenDiff !== 0) return lenDiff;
    const aBad = (a.match(/[IOQ]/g) || []).length;
    const bBad = (b.match(/[IOQ]/g) || []).length;
    return aBad - bBad;
  });
  if (vinList.length > 0) fields.bodyNumber = vinList[0];

  // === D — Marka ===
  const upperAll = (backText + '\n' + backAlpha).toUpperCase();
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp(`\\b${b.replace(' ', '\\s+').replace('-', '[-\\s]?')}\\b`);
    if (re.test(upperAll)) { fields.brand = b; break; }
  }
  if (!fields.brand) {
    // "D" etiketinin yanındakı 3-12 simvolluq token-ə fuzzy match
    const dToken = backText.match(/\bD\s+([A-Z][A-Z0-9]{2,12})\b/) || backAlpha.match(/\bD\s+([A-Z][A-Z0-9]{2,12})\b/);
    if (dToken) {
      const tok = dToken[1].toUpperCase();
      for (const b of KNOWN_BRANDS) {
        if (b.length >= 3 && tok.length >= 3 && tok.startsWith(b.slice(0, 2)) && Math.abs(b.length - tok.length) <= 2) {
          fields.brand = b; break;
        }
      }
    }
  }

  // === D.2 — Model ===
  if (fields.brand) {
    const re = new RegExp(`${fields.brand.replace(' ', '\\s+').replace('-', '[-\\s]?')}\\s+([A-Z0-9][A-Z0-9 -]{0,30})`, 'i');
    const m = upperAll.match(re);
    if (m) {
      const candidate = squash(m[1]).replace(/\s+(MİNİK|MINIK|UNIVERSAL|SEDAN|HATCHBACK).*$/i, '');
      if (candidate.length >= 2 && candidate.length <= 30) fields.model = candidate;
    }
  }

  // === D.3 — Tip ===
  const typeMatch = (backText + '\n' + backAlpha).match(/\b(M[İI]N[İI]K|UNIVERSAL|SEDAN|HATCHBACK|M[İI]N[İI]VAN|P[İI]KAP|Y[ÜU]K|AVTOBUS)\b/i);
  if (typeMatch) fields.vehicleType = typeMatch[1].toUpperCase();

  // === E.1 — Mühərrik nömrəsi ===
  // Token ən az 1 rəqəm ehtiva etməlidir ki etiket sözünün özü ("Muherrik")
  // səhvən tutulmasın. 6-15 simvol uzunluğunda, içində rəqəm olan alfanumeric.
  const engCombined = backText + '\n' + backAlpha;
  const engCandidates = [...engCombined.matchAll(
    /(?:E\.?\s*1|M[üu]h[əe]rr?ik\s+n[öo]m\w*)[\s\S]{0,40}?\b([A-Z0-9]*\d[A-Z0-9]*)\b/gi,
  )];
  for (const m of engCandidates) {
    const tok = m[1];
    if (tok.length >= 6 && tok.length <= 15 && tok !== fields.bodyNumber) {
      fields.engineNumber = tok;
      break;
    }
  }

  // === E.3 — Şassi nömrəsi (içində rəqəm məcburi) ===
  const chassisCombined = backText + '\n' + backAlpha;
  const chassisCandidates = [...chassisCombined.matchAll(
    /(?:E\.?\s*3|Şassi|Sassi|Chassis)[\s\S]{0,40}?\b([A-Z0-9]*\d[A-Z0-9]*)\b/gi,
  )];
  for (const m of chassisCandidates) {
    const tok = m[1];
    if (tok.length >= 6 && tok.length <= 17 && tok !== fields.bodyNumber && tok !== fields.engineNumber) {
      fields.chassisNumber = tok;
      break;
    }
  }

  // === E.4 — Rəng ===
  // Etiketin özü dəyər kimi tutulmamalıdır (Rengi, Color, Rəngi və s.).
  const COLOR_LABEL_BLACKLIST = /^(R[əea]ng\w*|Color|Cvet)$/i;
  for (const line of backText.split(/\n/)) {
    if (!/(E\.?\s*4|R[əea]ng\w*|Color)/i.test(line)) continue;
    // E.4 etiketi və/və ya "Rəngi" sözündən sonra real dəyəri tap
    const m = line.match(
      /(?:E\.?\s*4|R[əea]ng\w*|Color)[\s:.,-]+(?:(?:R[əea]ng\w*|Color)[\s:.,-]+)?([A-ZƏŞÇÖÜĞ][A-Za-zƏŞÇÖÜĞəşçöüğı]{0,14})/i,
    );
    if (m && !COLOR_LABEL_BLACKLIST.test(m[1])) {
      fields.color = m[1];
      break;
    }
  }

  // === F.1 — Maksimum kütlə ===
  for (const line of backText.split(/\n/)) {
    if (/(F\.?\s*1|Maks\w*\s+k[üu]tl|Maximum\s+mass)/i.test(line) && !fields.maxMass) {
      const m = line.match(/\b([12]?\d{3,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 600 && n <= 30000) fields.maxMass = m[1];
      }
    }
    if (/(F\.?\s*2|Y[üu]ks[üu]z|Unloaded\s+mass)/i.test(line) && !fields.unloadedMass) {
      const m = line.match(/\b([12]?\d{3,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 500 && n <= 25000) fields.unloadedMass = m[1];
      }
    }
  }

  // === F.3 — Oturacaq sayı ===
  for (const line of backText.split(/\n/)) {
    if (!/(F\.?\s*3|Oturaca)/i.test(line)) continue;
    const labelMatch = line.match(/F\.?\s*3|Oturaca\w*/i);
    const labelEnd = labelMatch ? (labelMatch.index ?? 0) + labelMatch[0].length : 0;
    const tail = line.slice(labelEnd);
    const m = tail.match(/(?<![\d.])(\d{1,2})(?![\d.])/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 29) { fields.seatCount = n; break; }
    }
  }

  // === G — Mühərrik həcmi ===
  for (const line of backText.split(/\n/)) {
    if (!/(\bG\b|M[üu]h[əe]rr?ik[iı]?n?\s+h[əe]cm|Engine\s+capacity)/i.test(line)) continue;
    const m = line.match(/\b((?:[89]\d{2}|[1-6]\d{3}))\b/);
    if (m) { fields.engineCapacity = m[1]; break; }
  }

  // === Kart seriyası ===
  const serial = (frontText + '\n' + frontAlpha).match(/\b([A-Z]{2}\d{6,8})\b/);
  if (serial) fields.cardSerial = serial[1];

  // === C.1 — Mülkiyyətçi ===
  const ownerWithSuffix = frontText.match(
    /\b([ƏA-ZÇŞÜÖĞİ]{2,}(?:\s+[ƏA-ZÇŞÜÖĞİ]{2,}){1,3}\s+(?:OĞLU|OGLU|OQLU|QIZI|QIZ[İI]))\b/i,
  );
  if (ownerWithSuffix) fields.ownerName = squash(ownerWithSuffix[1]).toUpperCase();

  // === C.2 — Ünvan ===
  const addr = frontText.match(
    /((?:Bakı|Baki|Sumqayıt|Sumqayit|Gəncə|Gence|Mingəçevir|Mingacevir|Şirvan|Sirvan|Naxçıvan|Naxcivan|Şəki|Seki|Lənkəran|Lenkeran)\s*ş?əh?\.?[^\n]{5,120})/i,
  );
  if (addr) fields.ownerAddress = squash(addr[1]);

  // === C.3 — Mülkiyyət növü ===
  if (/Fiziki\s+(?:şəxs|sexs|sehs)/i.test(frontText)) fields.ownershipType = 'Fiziki şəxs';
  else if (/H[üu]quqi\s+(?:şəxs|sexs|sehs)/i.test(frontText)) fields.ownershipType = 'Hüquqi şəxs';

  // === Verilib (orqan) ===
  const issued = (backText + '\n' + backAlpha).match(/\b(AR\s+D[İI]N[^\n]{0,30}|BDYP[İI][^\n]{0,20})\b/);
  if (issued) fields.issuedBy = squash(issued[0]);

  // === H — Etibarlıdır ===
  const validUntil = frontText.match(/(?:H\b|Etibarl[ıi])[^\n]{0,40}?([0-3]?\d\.[0-1]?\d\.(?:19|20)\d{2})/i);
  if (validUntil) fields.validUntil = validUntil[1];

  return fields;
}

// === İKİ ŞƏKİL ÜÇÜN MULTI-PASS PIPELINE ===

export interface OCRResult {
  ok: boolean;
  fields: OCRFields;
  filledCount: number;
  rawText: string;
}

async function runAllPasses(imagePath: string): Promise<{ normal: string; hc: string; thr: string; alpha: string }> {
  // Paralel deyil — Tesseract worker single-threaded olduğuna görə paralel
  // çağırış serializasiya olur. Ardıcıl daha proqnozlaşdırılandır.
  const normal = await ocrText(imagePath, 'normal').catch((e) => {
    console.error('[passportOCR] normal pass failed:', e?.message); return '';
  });
  const hc = await ocrText(imagePath, 'highContrast').catch((e) => {
    console.error('[passportOCR] highContrast pass failed:', e?.message); return '';
  });
  const thr = await ocrText(imagePath, 'threshold').catch((e) => {
    console.error('[passportOCR] threshold pass failed:', e?.message); return '';
  });
  const alpha = await ocrAlphaNum(imagePath).catch((e) => {
    console.error('[passportOCR] alphaNum pass failed:', e?.message); return '';
  });
  return { normal, hc, thr, alpha };
}

export async function extractWithOCR(frontPath: string, backPath: string): Promise<OCRResult> {
  let frontPasses = { normal: '', hc: '', thr: '', alpha: '' };
  let backPasses = { normal: '', hc: '', thr: '', alpha: '' };
  try {
    frontPasses = await runAllPasses(frontPath);
    backPasses = await runAllPasses(backPath);
  } catch (err: any) {
    console.error('[passportOCR] failed:', err?.message);
    return { ok: false, fields: {}, filledCount: 0, rawText: '' };
  }

  // Bütün passların mətnini birləşdir — parser hər sahə üçün tapdığı ilk
  // doğru namizədi seçir.
  const frontCombined = `${frontPasses.normal}\n${frontPasses.hc}\n${frontPasses.thr}`;
  const backCombined = `${backPasses.normal}\n${backPasses.hc}\n${backPasses.thr}`;
  const fields = parsePassportText(frontCombined, backCombined, frontPasses.alpha, backPasses.alpha);

  const filledCount = Object.values(fields).filter((v) => v !== undefined && v !== null && v !== '').length;
  const hasCritical = !!(fields.bodyNumber && fields.brand && fields.manufactureYear);
  const ok = filledCount >= 8 && hasCritical;

  // path-ı log üçün lazım, debug-da vacib
  void path;

  return {
    ok,
    fields,
    filledCount,
    rawText:
      `=== FRONT (normal) ===\n${frontPasses.normal}\n` +
      `=== FRONT (hi-contrast) ===\n${frontPasses.hc}\n` +
      `=== FRONT (threshold) ===\n${frontPasses.thr}\n` +
      `=== FRONT (alphaNum) ===\n${frontPasses.alpha}\n` +
      `=== BACK (normal) ===\n${backPasses.normal}\n` +
      `=== BACK (hi-contrast) ===\n${backPasses.hc}\n` +
      `=== BACK (threshold) ===\n${backPasses.thr}\n` +
      `=== BACK (alphaNum) ===\n${backPasses.alpha}`,
  };
}

// Server kapanan zaman worker-ləri təmizlə
process.once('exit', () => {
  if (normalWorker) normalWorker.then((w) => w.terminate()).catch(() => {});
  if (alphaNumWorker) alphaNumWorker.then((w) => w.terminate()).catch(() => {});
});
