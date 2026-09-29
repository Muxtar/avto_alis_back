# e-kassa agenti (Bakı)

e-kassa portalı **yalnız Azərbaycan IP-lərinə** açıqdır (40 xarici serverdən yoxlanılıb — hamısı timeout).
Bu agent Azərbaycandakı istənilən kompüterdə işləyir (ev/ofis kompüteri, Raspberry Pi, AZ VPS),
serverə **özü qoşulur** — port açmaq, domen, VPS lazım deyil.

1. Railway backend env: `EKASSA_AGENT_KEY=<openssl rand -hex 24>`
2. Bakıdakı kompüterdə (Node 18+):
   `AGENT_KEY=<eyni açar> node agent.mjs`
   Daimi işləməsi üçün: `npx pm2 start agent.mjs --name ekassa-agent` (+ `pm2 save`, `pm2 startup`).
3. Yoxlama: `https://avtoalisback-production.up.railway.app/api/receipts/diag` → `agent.online: true`.

Agent qoşulu olanda QR oxunan kimi çek avtomatik gəlir və oxunur. Qoşulu olmayanda sayt
istifadəçiyə «e-kassadan yüklə → seç» yolunu göstərir. Kompüter sönəndə sadəcə həmin yola qayıdır.
