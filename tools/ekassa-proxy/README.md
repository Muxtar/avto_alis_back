# e-kassa proxy (Azərbaycan)

e-kassa portalı (`monitoring.e-kassa.gov.az`) yalnız **Azərbaycan IP-lərinə** açıqdır —
Railway-dən qoşulma `UND_ERR_CONNECT_TIMEOUT` verir. Bu kiçik proxy Azərbaycandakı
hər hansı serverdə (VPS) işləyir və çek şəklini backend-ə ötürür.

1. Azərbaycanda Node 18+ olan server (VPS) götürün.
2. `server.mjs` faylını ora köçürün və işə salın:
   `PROXY_KEY=$(openssl rand -hex 24) PORT=8080 node server.mjs` (pm2/systemd ilə daimi).
3. HTTPS (nginx + Let's Encrypt və ya Cloudflare) ilə ünvan verin.
4. Railway backend-də env qoyun:
   - `EKASSA_PROXY_URL=https://<proxy ünvanı>`
   - `EKASSA_PROXY_KEY=<eyni açar>`
5. Yoxlama: `https://<backend>/api/receipts/diag` — `portal.ok` hələ birbaşa yoxlanır;
   QR skan edəndə çek artıq foto istəmədən açılmalıdır.

Proxy yalnız `GET /doc/<fiskal ID>` qəbul edir, açarsız sorğunu rədd edir, başqa saytlara sorğu ötürmür.
