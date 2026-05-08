// Azərbaycan texniki pasportu üçün TAM LOCAL pasport oxuma servisi.
//
// Heç bir xarici API (OpenAI, DeepSeek, Anthropic, Google) istifadə edilmir.
// Bütün iş `tesseract.js` (Wasm OCR engine) və `sharp` (şəkil emalı)
// kitabxanaları ilə kullanıcının kompüterində/serverdə icra olunur.
//
// Strategiya: hər şəkili 4 fərqli ön emal variantında oxuyub bütün mətnləri
// birləşdiririk, sonra parser hər sahə üçün ən yaxşı namizədi seçir. Multi-pass
// yanaşması tək bir pass-də zəif çıxan VIN, mühərrik nömrəsi kimi çətin sahələri
// tutmağa kömək edir.

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

export async function extractPassportFromFiles(
  frontPath: string,
  backPath: string,
): Promise<PassportExtractionResult> {
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
