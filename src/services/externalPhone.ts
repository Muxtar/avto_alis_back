/**
 * KƏNAR ELANIN ƏLAQƏ NÖMRƏSİ — yalnız istifadəçi «Təklif göndər» basanda, yalnız
 * həmin BİR elan üçün çağırılır (əvvəlcədən/toplu yığım yoxdur).
 *
 * Yalnız nömrənin elan səhifəsində AÇIQ yazıldığı saytlar:
 *   • turbo.az  — səhifə mətnində: phones":["(050) 211-15-53"]
 *   • lalafo.az — səhifə məlumatında: "mobile":"+994…","hide_phone":false
 * tap.az və bina.az nömrəni «Nömrəni göstər» klikinin arxasında saxlayır (ayrıca
 * sorğu). O qoruma QƏSDƏN keçilmir — həmin elanlarda nömrəni admin əl ilə daxil edir.
 */
import { fetchHtml } from './shopScrapers';

export const OFFER_SITES = ['tap.az', 'turbo.az', 'bina.az', 'lalafo.az'];

/** Son 9 rəqəm — uyğunlaşdırma açarı (+994 50…, 050… eyni). */
export const phoneKeyOf = (phone: string | null | undefined) => String(phone || '').replace(/\D/g, '').slice(-9);

/** AZ mobil nömrəsi → "+994XXXXXXXXX"; düzgün deyilsə null. */
export function normalizeAzPhone(raw: string | null | undefined): string | null {
  const key = phoneKeyOf(raw);
  // Mobil prefikslər: 10, 50, 51, 55, 60, 70, 77, 99 (şəhər nömrələri — 12… — qəbul edilmir).
  if (!/^(10|50|51|55|60|70|77|99)\d{7}$/.test(key)) return null;
  return '+994' + key;
}

export function siteOfUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^(www|ru|en)\./, '').toLowerCase(); } catch { return ''; }
}

/** Linki normallaşdır: https, www/dil prefiksi və sorğu/hash olmadan. */
export function normalizeListingUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.replace(/^(www|ru|en)\./, '').toLowerCase();
    if (!OFFER_SITES.includes(host)) return null;
    const path = u.pathname.replace(/\/+$/, '');
    if (path.length < 2) return null;
    return `https://${host}${path}`;
  } catch { return null; }
}

export async function lookupListingPhone(url: string): Promise<string | null> {
  const site = siteOfUrl(url);
  if (site !== 'turbo.az' && site !== 'lalafo.az') return null;   // tap.az / bina.az — admin daxil edir
  const page = await fetchHtml(url).catch(() => null);
  if (!page) return null;
  const html = page.html;
  if (site === 'turbo.az') {
    const m = html.match(/phones(?:&quot;|"):\[(?:&quot;|")([^&"\]]{7,20})/);
    return m ? normalizeAzPhone(m[1]) : null;
  }
  // lalafo: elanın ÖZ sahibi (oxşar elanların nömrələri deyil) və gizlədilməyibsə.
  const m = html.match(/"mobile":"(\+?\d{9,13})","email":"[^"]*","hide_phone":(true|false)/);
  return m && m[2] === 'false' ? normalizeAzPhone(m[1]) : null;
}
