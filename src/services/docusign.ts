// DOCUSIGN — satıcı müqaviləsinin qarşılıqlı elektron imzalanması.
//
// Axın: JWT ilə token → zərf (envelope) yaradılır → hər iki tərəfə imza dəvəti
// gedir → imza bitəndə DocuSign webhook göndərir → imzalanmış PDF endirilir.
//
// İmza sırası: əvvəlcə SATICI, sonra PLATFORMA (routingOrder 1 və 2).
// Belə olanda satıcı imzalamadan bizim direktor imzalamır.
//
// QOŞULMAYIBSA: bütün funksiyalar `configured: false` qaytarır — sistem
// sınmır, sadəcə "DocuSign qurulmayıb" deyir. Lazımi env dəyişənləri:
//   DOCUSIGN_INTEGRATION_KEY   (Integration Key / client id)
//   DOCUSIGN_USER_ID           (imzalayan API istifadəçisinin GUID-i)
//   DOCUSIGN_ACCOUNT_ID        (API Account ID)
//   DOCUSIGN_PRIVATE_KEY       (RSA private key — \n-lər real sətir olmalıdır)
//   DOCUSIGN_BASE_PATH         (demo: https://demo.docusign.net/restapi)
//   DOCUSIGN_OAUTH_HOST        (demo: account-d.docusign.com)

import jwt from 'jsonwebtoken';

const IK = process.env.DOCUSIGN_INTEGRATION_KEY || '';
const USER_ID = process.env.DOCUSIGN_USER_ID || '';
const ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID || '';
const PRIVATE_KEY = (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const BASE = (process.env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi').replace(/\/$/, '');
const OAUTH_HOST = process.env.DOCUSIGN_OAUTH_HOST || 'account-d.docusign.com';

export function isDocusignConfigured(): boolean {
  return !!(IK && USER_ID && ACCOUNT_ID && PRIVATE_KEY);
}

// Token 1 saat etibarlıdır — yaddaşda saxlayırıq, hər zərf üçün yenidən almırıq.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: IK, sub: USER_ID, aud: OAUTH_HOST, iat: now, exp: now + 3600, scope: 'signature impersonation' },
    PRIVATE_KEY,
    { algorithm: 'RS256' },
  );
  const res = await fetch(`https://${OAUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    // Ən çox rast gəlinən hal: istifadəçi tətbiqə hələ icazə (consent) verməyib.
    const hint = data?.error === 'consent_required'
      ? ' — DocuSign hesabında tətbiqə bir dəfəlik icazə verilməlidir (consent URL)'
      : '';
    throw new Error(`DocuSign token alınmadı: ${data?.error || res.status}${hint}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function dsFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2.1/accounts/${ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.message || `DocuSign xətası (HTTP ${res.status})`);
  return data;
}

/** Müqavilə mətnini sadə, çap üçün uyğun HTML-ə çevir (DocuSign HTML qəbul edir). */
function toHtml(title: string, text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font-family:"DejaVu Sans",Arial,sans-serif;font-size:11pt;line-height:1.55;color:#111;margin:36px}
 pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:inherit;margin:0}
</style></head><body><pre>${esc(text)}</pre></body></html>`;
}

export interface EnvelopeSigner {
  name: string;
  email: string;
  /** İmza sırası — kiçik rəqəm əvvəl imzalayır. */
  order: number;
}

/**
 * Müqaviləni imzaya göndər.
 * `anchor` — mətndəki hansı sözün yanında imza xanası çıxacağı.
 */
export async function sendContractForSignature(params: {
  title: string;
  text: string;
  seller: EnvelopeSigner;
  platform: EnvelopeSigner;
  emailSubject?: string;
}): Promise<{ ok: boolean; envelopeId?: string; message?: string }> {
  if (!isDocusignConfigured()) return { ok: false, message: 'DocuSign qoşulmayıb — env dəyişənləri təyin edilməlidir' };
  try {
    const doc = {
      documentBase64: Buffer.from(toHtml(params.title, params.text), 'utf8').toString('base64'),
      name: params.title,
      fileExtension: 'html',
      documentId: '1',
    };
    // İmza xanaları mətindəki «İmza:» sözlərinə bağlanır (anchor).
    const mkSigner = (s: EnvelopeSigner, recipientId: string) => ({
      email: s.email,
      name: s.name,
      recipientId,
      routingOrder: String(s.order),
      tabs: {
        signHereTabs: [{
          anchorString: 'İmza:',
          anchorUnits: 'pixels',
          anchorXOffset: '90',
          anchorYOffset: '-6',
          anchorIgnoreIfNotPresent: 'false',
          // Hər imzalayan ÖZ sətrini imzalasın: satıcı sonuncunu, platforma birincini.
          anchorMatchWholeWord: 'false',
        }],
        dateSignedTabs: [{ anchorString: 'Müqavilə tarixi:', anchorUnits: 'pixels', anchorXOffset: '120', anchorYOffset: '-4' }],
      },
    });
    const envelope = {
      emailSubject: params.emailSubject || params.title,
      documents: [doc],
      recipients: { signers: [mkSigner(params.seller, '1'), mkSigner(params.platform, '2')] },
      status: 'sent',
    };
    const r = await dsFetch('/envelopes', { method: 'POST', body: JSON.stringify(envelope) });
    if (!r?.envelopeId) return { ok: false, message: 'Zərf yaradılmadı' };
    return { ok: true, envelopeId: r.envelopeId };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

/** Zərfin vəziyyəti: sent | delivered | completed | declined | voided */
export async function getEnvelopeStatus(envelopeId: string): Promise<{ ok: boolean; status?: string; message?: string }> {
  if (!isDocusignConfigured()) return { ok: false, message: 'DocuSign qoşulmayıb' };
  try {
    const r = await dsFetch(`/envelopes/${envelopeId}`);
    return { ok: true, status: String(r?.status || '') };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

/** İmzalanmış sənədin PDF-i (bütün səhifələr birləşdirilmiş). */
export async function downloadSignedPdf(envelopeId: string): Promise<{ ok: boolean; buffer?: Buffer; message?: string }> {
  if (!isDocusignConfigured()) return { ok: false, message: 'DocuSign qoşulmayıb' };
  try {
    const token = await getAccessToken();
    const res = await fetch(`${BASE}/v2.1/accounts/${ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, message: `PDF endirilmədi (HTTP ${res.status})` };
    return { ok: true, buffer: Buffer.from(await res.arrayBuffer()) };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

/** DocuSign statusunu bizim `contractStatus`-a çevir. */
export function mapEnvelopeStatus(s: string): 'SENT' | 'SIGNED' | 'DECLINED' | 'VOIDED' | null {
  switch ((s || '').toLowerCase()) {
    case 'sent': case 'delivered': return 'SENT';
    case 'completed': return 'SIGNED';
    case 'declined': return 'DECLINED';
    case 'voided': return 'VOIDED';
    default: return null;
  }
}
