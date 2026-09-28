// E-KASSA PROXY — Azərbaycanda yerləşən serverdə işləyir (portal yalnız AZ IP-lərinə açıqdır).
// Asılılıq yoxdur, Node 18+.  İşə salmaq:
//   PROXY_KEY=<uzun-gizli-açar> PORT=8080 node server.mjs
// Backend (Railway) env:  EKASSA_PROXY_URL=https://<bu-server>  EKASSA_PROXY_KEY=<eyni açar>
//
// Yalnız bir iş görür: GET /doc/<fiskal ID>  →  e-kassa çek şəkli (image/jpeg).
// Başqa ünvana sorğu ötürmür (açıq proxy deyil), açarsız sorğunu rədd edir.
import http from 'node:http';

const KEY = process.env.PROXY_KEY || '';
const PORT = Number(process.env.PORT || 8080);
const FISCAL_RE = /^[A-HJ-NP-Za-km-z1-9]{10,64}$/;
if (KEY.length < 24) { console.error('PROXY_KEY ən azı 24 simvol olmalıdır'); process.exit(1); }

http.createServer(async (req, res) => {
  const m = (req.url || '').match(/^\/doc\/([^/?#]+)$/);
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.method !== 'GET' || !m) { res.writeHead(404); res.end(); return; }
  if (req.headers['x-proxy-key'] !== KEY) { res.writeHead(401); res.end(); return; }
  const id = decodeURIComponent(m[1]);
  if (!FISCAL_RE.test(id)) { res.writeHead(400); res.end(); return; }
  try {
    const r = await fetch(`https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/${encodeURIComponent(id)}`, {
      headers: { 'User-Lang': req.headers['user-lang'] === 'en' ? 'en' : 'az' },
      signal: AbortSignal.timeout(12000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    // Statusu olduğu kimi ötür (200 — çek, 209 — «çek tapılmadı» şəkli).
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    res.writeHead(504); res.end(String(e?.cause?.code || e?.message || 'timeout'));
  }
}).listen(PORT, () => console.log(`e-kassa proxy :${PORT}`));
