// Veriff (peşəkar KYC/şəxsiyyət doğrulama) inteqrasiyası.
// Sənəd: https://devdocs.veriff.com
// Açarlar KODA YAZILMIR — env-dən oxunur (Railway):
//   VERIFF_API_KEY    — inteqrasiyanın API açarı (X-AUTH-CLIENT)
//   VERIFF_SECRET     — shared secret (HMAC imzaları üçün)
//   VERIFF_BASE_URL   — default https://stationapi.veriff.com
import crypto from 'crypto';

const BASE = process.env.VERIFF_BASE_URL || 'https://stationapi.veriff.com';
const API_KEY = process.env.VERIFF_API_KEY || '';
const SECRET = process.env.VERIFF_SECRET || '';

export function isVeriffConfigured(): boolean {
  return !!(API_KEY && SECRET);
}

// HMAC-SHA256 hex imzası (sessiya id və ya raw body üçün).
export function veriffHmac(payload: string | Buffer): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

// Webhook imzasını yoxla — X-HMAC-SIGNATURE raw body üzərində hesablanır.
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!SECRET || !rawBody || !signature) return false;
  const expected = veriffHmac(rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(String(signature).toLowerCase(), 'utf8'));
  } catch {
    return false;
  }
}

// Doğrulama sessiyası yarat — istifadəçi qaytarılan URL-də sənəd + video-selfie çəkir.
export async function createVeriffSession(params: {
  userId: number;
  firstName?: string;
  lastName?: string;
  callbackUrl?: string; // istifadəçi bitirdikdən sonra yönləndiriləcəyi səhifə
}): Promise<{ ok: boolean; sessionId?: string; url?: string; error?: string }> {
  if (!isVeriffConfigured()) return { ok: false, error: 'Veriff qoşulmayıb (VERIFF_API_KEY/VERIFF_SECRET yoxdur)' };
  try {
    const body = {
      verification: {
        // vendorData — webhook-da istifadəçini tapmaq üçün bizim user id.
        vendorData: String(params.userId),
        ...(params.callbackUrl ? { callback: params.callbackUrl } : {}),
        person: {
          ...(params.firstName ? { firstName: params.firstName } : {}),
          ...(params.lastName ? { lastName: params.lastName } : {}),
        },
        timestamp: new Date().toISOString(),
      },
    };
    const res = await fetch(`${BASE}/v1/sessions`, {
      method: 'POST',
      headers: {
        'X-AUTH-CLIENT': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.verification?.id) {
      return { ok: false, error: data?.message || data?.error || `Veriff xətası (HTTP ${res.status})` };
    }
    return { ok: true, sessionId: data.verification.id, url: data.verification.url };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// Sessiyanın qərarını sorğula (webhook gəlməyibsə əl ilə yoxlamaq üçün).
export async function getVeriffDecision(sessionId: string): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (!isVeriffConfigured()) return { ok: false, error: 'Veriff qoşulmayıb' };
  try {
    const res = await fetch(`${BASE}/v1/sessions/${sessionId}/decision`, {
      method: 'GET',
      headers: {
        'X-AUTH-CLIENT': API_KEY,
        // GET sorğularında imza sessiya id-si üzərindən hesablanır.
        'X-HMAC-SIGNATURE': veriffHmac(sessionId),
        'Content-Type': 'application/json',
      },
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.message || `Veriff xətası (HTTP ${res.status})` };
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
