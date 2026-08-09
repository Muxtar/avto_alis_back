// Avatar proxy — sosial media profil şəkillərini ÖZ serverimizdən verir.
//
// Niyə lazımdır: Instagram/Facebook/TikTok profil şəkilləri birbaşa <img src="...">
// ilə açılmır — CDN "hotlink" qorumasına görə başqa domendən gələn sorğunu 403 edir,
// üstəlik linklərdə müddəti bitən imza olur. Şəkli serverdə yükləyib öz domenimizdən
// verməklə hər ikisi həll olunur.
//
// Təhlükəsizlik: yalnız BƏLLİ CDN hostlarına icazə var (SSRF qorunması),
// ölçü və vaxt limiti qoyulub, cavab yalnız şəkil tipində olmalıdır.
import { Router, Request, Response } from 'express';
import { rateLimit } from '../middleware/rateLimiter';

const router = Router();

// Şəkil çəkilməsinə icazə verilən hostlar (sonluq üzrə uyğunluq).
const ALLOWED_HOSTS = [
  'cdninstagram.com', 'fbcdn.net',                 // Instagram / Facebook
  'tiktokcdn.com', 'tiktokcdn-us.com', 'ibyteimg.com', // TikTok
  'licdn.com',                                      // LinkedIn
  'twimg.com',                                      // X (Twitter)
  'ggpht.com', 'googleusercontent.com', 'ytimg.com', // YouTube
  'telesco.pe', 't.me',                             // Telegram
  'unavatar.io',                                    // ehtiyat avatar xidməti
  'apify.com', 'apifyusercontent.com',              // Apify saxlanc linkləri
  // MƏHSUL kartlarının şəkilləri — AZ alış-veriş saytları öz og:image-lərini
  // öz domenlərindən verir (yoxlanılıb: tap.az → tap.az, lalafo.az → lalafo.az).
  'tap.az', 'turbo.az', 'bina.az', 'lalafo.az', 'umico.az', 'birmarket.az',
  'emalls.az', 'kontakt.az', 'irshad.az', 'bakuelectronics.az', 'trendyol.az',
  'soliton.az', 'texnomart.az', 'optimal.az', 'amerikan.az', 'maxi.az',
  'umico.b-cdn.net', 'strgimgr.umico.az', 'b-cdn.net',   // Umico/Birmarket CDN
];
function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

// Yaddaş keşi — eyni avatar təkrar-təkrar çəkilməsin.
interface Entry { at: number; buf: Buffer; type: string }
const cache = new Map<string, Entry>();
const TTL_MS = 6 * 60 * 60 * 1000;   // 6 saat
const MAX_ENTRIES = 300;
const MAX_BYTES = 3 * 1024 * 1024;   // 3 MB

const proxyLimiter = rateLimit(300, 60 * 60 * 1000); // saatda 300 şəkil / IP

router.get('/avatar-proxy', proxyLimiter, async (req: Request, res: Response) => {
  const raw = String(req.query.url || '');
  if (!raw) { res.status(400).send('url required'); return; }

  let target: URL;
  try { target = new URL(raw); } catch { res.status(400).send('bad url'); return; }
  if (!/^https?:$/.test(target.protocol) || !hostAllowed(target.hostname)) {
    res.status(403).send('host not allowed'); return;
  }

  // Keş — açar tam URL.
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.send(hit.buf);
    return;
  }

  try {
    const r = await fetch(target.toString(), {
      // Bəzi CDN-lər Referer/UA yoxlayır — brauzer kimi davranırıq.
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; tradixai/1.0; +https://tradixai.io)',
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { res.status(404).send('not found'); return; }
    const type = r.headers.get('content-type') || '';
    if (!type.startsWith('image/')) { res.status(415).send('not an image'); return; }
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) { res.status(413).send('too large'); return; }

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) { res.status(413).send('too large'); return; }

    cache.delete(raw);
    cache.set(raw, { at: Date.now(), buf, type });
    if (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.send(buf);
  } catch (e: any) {
    console.error('[avatar-proxy]', target.hostname, e?.name, e?.message);
    res.status(502).send('fetch failed');
  }
});

export default router;
