// 30 müxtəlif tipli test elanı — səhifə görünüşünü test etmək üçün.
// DİQQƏT: bütün mövcud elanları SİLİR, sonra 30 yeni elan yaradır.
// İşə salmaq:  DATABASE_URL="<railway-public-url>" npx tsx prisma/seed-test-listings.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const CITIES = ['Bakı', 'Gəncə', 'Sumqayıt', 'Mingəçevir', 'Şəki', 'Lənkəran'];
const pick = <T,>(a: T[], i: number) => a[i % a.length];

type Seed = {
  title: string; category: string; type: 'PRODUCT' | 'SERVICE'; price: number; brand?: string; desc: string;
  barter?: boolean; forRent?: boolean; bookable?: boolean; bookingType?: 'RESERVATION' | 'STAY';
  weightKg?: number; imgs?: number; // neçə şəkil (default 1)
};

const LISTINGS: Seed[] = [
  // ── Nəqliyyat ──
  { title: 'Toyota Camry 2019', category: 'Nəqliyyat › Minik avtomobilləri', type: 'PRODUCT', price: 32000, brand: 'Toyota', desc: 'Tam baxımlı, qəzasız, dəyiş-düş mümkündür.', barter: true, imgs: 3 },
  { title: 'Honda PCX 150 skuter', category: 'Nəqliyyat › Motosiklet və mopedlər', type: 'PRODUCT', price: 4500, brand: 'Honda', desc: 'Az işlənmiş skuter, ideal vəziyyət.', imgs: 2 },
  // ── Ehtiyat hissələr ──
  { title: 'Bosch əyləc diski (dəst)', category: 'Avtomobil ehtiyat hissələri › Əyləc sistemi', type: 'PRODUCT', price: 65, brand: 'Bosch', desc: 'Ön əyləc diski, original, kartla ödəniş.', weightKg: 6 },
  { title: 'Mahle hava filtri', category: 'Avtomobil ehtiyat hissələri › Filtrlər və yağlar', type: 'PRODUCT', price: 18, brand: 'Mahle', desc: 'Universal hava filtri, topdan mövcuddur.', weightKg: 0.5 },
  // ── Daşınmaz əmlak ──
  { title: '2 otaqlı mənzil, Nizami (kirayə)', category: 'Daşınmaz əmlak › Mənzillər (yeni tikili)', type: 'PRODUCT', price: 700, desc: 'Aylıq kirayə, təmirli, mərkəzdə.', forRent: true, imgs: 3 },
  { title: 'Həyət evi, Mərdəkan', category: 'Daşınmaz əmlak › Evlər və villalar', type: 'PRODUCT', price: 180000, desc: '4 otaqlı həyət evi, hovuzlu.', imgs: 2 },
  // ── Elektronika ──
  { title: 'iPhone 14 Pro 128GB', category: 'Elektronika › Telefonlar', type: 'PRODUCT', price: 1800, brand: 'Apple', desc: 'İdeal vəziyyətdə, qutulu.', imgs: 3, weightKg: 0.4 },
  { title: 'Lenovo IdeaPad noutbuk', category: 'Elektronika › Noutbuklar', type: 'PRODUCT', price: 950, brand: 'Lenovo', desc: 'i5, 16GB RAM, SSD 512GB.', weightKg: 2 },
  { title: 'Samsung 55" 4K TV', category: 'Elektronika › TV və proyektorlar', type: 'PRODUCT', price: 1100, brand: 'Samsung', desc: '4K Smart TV, zəmanətli.', weightKg: 18 },
  // ── Məişət texnikası ──
  { title: 'Bosch soyuducu No Frost', category: 'Məişət texnikası › Soyuducular', type: 'PRODUCT', price: 850, brand: 'Bosch', desc: '2 kameralı, enerji A++.', weightKg: 60 }, // >50kg — Yango bağlanmalı
  { title: 'Philips blender 700W', category: 'Məişət texnikası › Mətbəx texnikası', type: 'PRODUCT', price: 75, brand: 'Philips', desc: 'Güclü blender, 2 qab.', weightKg: 2 },
  // ── Ev və bağ ──
  { title: 'Künc divan (açılan)', category: 'Ev və bağ › Mebel', type: 'PRODUCT', price: 600, desc: 'Açılan künc divan, yenidir.', imgs: 2, weightKg: 45 },
  { title: 'Əl işi yun xalça 2x3', category: 'Ev və bağ › Xalça və tekstil', type: 'PRODUCT', price: 320, desc: 'Təbii yun, dəyiş-düş olar.', barter: true },
  // ── Tikinti və təmir ──
  { title: 'Makita şarjlı drel', category: 'Tikinti və təmir › Alət və avadanlıq', type: 'PRODUCT', price: 140, brand: 'Makita', desc: '2 batareya, çantalı.' },
  { title: 'Sement 50kq (topdan)', category: 'Tikinti və təmir › Sement, qum, kərpic', type: 'PRODUCT', price: 12, desc: 'Portland sement.', weightKg: 50 },
  // ── Geyim və aksesuar ──
  { title: 'Kişi dəri gödəkçə', category: 'Geyim və aksesuar › Kişi geyimi', type: 'PRODUCT', price: 130, desc: 'Original dəri, L ölçü.' },
  { title: 'Qadın çantası (yeni model)', category: 'Geyim və aksesuar › Çantalar', type: 'PRODUCT', price: 85, desc: 'Yeni model, dəyiş-düş olar.', barter: true },
  { title: 'Nike Air Max krossovka', category: 'Geyim və aksesuar › Ayaqqabı', type: 'PRODUCT', price: 160, brand: 'Nike', desc: '42 ölçü, orijinal.', imgs: 2 },
  // ── Gözəllik ──
  { title: 'Dior ətir 100ml', category: 'Gözəllik və sağlamlıq › Ətriyyat', type: 'PRODUCT', price: 190, brand: 'Dior', desc: 'Original, bağlı qutu.' },
  // ── Uşaq aləmi ──
  { title: 'Uşaq arabası 3in1', category: 'Uşaq aləmi › Uşaq arabaları', type: 'PRODUCT', price: 280, desc: 'Tam komplekt, təmiz.', imgs: 2 },
  { title: 'Lego konstruktor 500+', category: 'Uşaq aləmi › Oyuncaqlar', type: 'PRODUCT', price: 60, brand: 'Lego', desc: '500+ detal.' },
  // ── Hobbi və idman ──
  { title: 'Dağ velosipedi 26"', category: 'Hobbi və idman › Velosipedlər', type: 'PRODUCT', price: 240, desc: 'İşlək, yüngül ram.', imgs: 2 },
  { title: 'Yamaha akustik gitara', category: 'Hobbi və idman › Musiqi alətləri', type: 'PRODUCT', price: 210, brand: 'Yamaha', desc: 'Yeni simlərlə.' },
  // ── Heyvanlar / K.təsərrüfatı ──
  { title: 'Alman çoban iti balası', category: 'Heyvanlar › İtlər', type: 'PRODUCT', price: 400, desc: 'Sənədli, peyvəndli.' },
  { title: 'Təbii dağ balı 1kq', category: 'Kənd təsərrüfatı › Məhsullar (bal, meyvə)', type: 'PRODUCT', price: 25, desc: 'Saf dağ balı.' },

  // ── BRON / REZERVASİYA (yeni funksiya) ──
  { title: 'Şəhər mərkəzində restoran — masa rezervasiyası', category: 'Turizm, istirahət və məkan › Restoran və kafe', type: 'PRODUCT', price: 0, desc: 'Masa rezerv edin, axşam üçün yerinizi tutun.', bookable: true, bookingType: 'RESERVATION', imgs: 2 },
  { title: 'Dəniz kənarı bağ evi (günlük)', category: 'Turizm, istirahət və məkan › Bağ evi və villa (günlük)', type: 'PRODUCT', price: 250, desc: 'Günlük kirayə, hovuz + mangal.', bookable: true, bookingType: 'STAY', imgs: 3 },
  { title: 'Butik otel — gecələmə', category: 'Turizm, istirahət və məkan › Otel və mehmanxana', type: 'PRODUCT', price: 90, desc: 'Bir gecə, səhər yeməyi daxil.', bookable: true, bookingType: 'STAY', imgs: 2 },

  // ── XİDMƏTLƏR ──
  { title: 'Avtomobil kompüter diaqnostikası', category: 'Xidmətlər › Avtomobil xidmətləri', type: 'SERVICE', price: 30, desc: 'Bütün markalar, yerində.' },
  { title: 'İngilis dili repetitoru (onlayn)', category: 'Xidmətlər › Təhsil və repetitor', type: 'SERVICE', price: 15, desc: 'Fərdi dərslər, çevik saat.' },
];

async function main() {
  const sel = { id: true, name: true, phone: true } as const;
  let seller = await prisma.user.findFirst({ where: { role: 'USER' }, orderBy: { id: 'asc' }, select: sel });
  if (!seller) {
    seller = await prisma.user.create({
      data: { name: 'Test Satıcı', phone: '+994500000000', type: 'PARTS_SELLER', profileComplete: true, verified: true },
      select: sel,
    });
  }
  console.log(`Satıcı: #${seller.id} (${seller.name || seller.phone})`);

  // BÜTÜN elanları sil (istifadəçi istəyi — təmiz test).
  const del = await prisma.listing.deleteMany({});
  console.log(`Silinən elanlar: ${del.count}`);

  const now = Date.now();
  let n = 0;
  for (let i = 0; i < LISTINGS.length; i++) {
    const l = LISTINGS[i];
    const count = l.imgs || 1;
    // Stabil demo şəkillər (picsum — real foto CDN). Frontend http URL-i olduğu kimi göstərir.
    const images = Array.from({ length: count }, (_, k) => `https://picsum.photos/seed/tradixai-${i + 1}-${k + 1}/700/500`);
    // Pilləli createdAt: i=0 ən yeni (indi), sonrakılar getdikcə köhnə → sıralama testi.
    const createdAt = new Date(now - i * 3 * 60 * 60 * 1000); // hər elan 3 saat fərq
    await prisma.listing.create({
      data: {
        userId: seller.id,
        title: l.title,
        description: l.desc,
        price: l.price,
        category: l.category,
        type: l.type,
        images,
        condition: 'NEW',
        brand: l.brand || null,
        stock: l.type === 'SERVICE' ? 1 : 10,
        city: pick(CITIES, i),
        barter: !!l.barter,
        forRent: !!l.forRent,
        bookable: !!l.bookable,
        bookingType: l.bookable ? (l.bookingType || 'RESERVATION') : null,
        weightKg: l.weightKg ?? null,
        createdAt,
        expiresAt: new Date(now + 20 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    n++;
  }
  const svc = LISTINGS.filter((x) => x.type === 'SERVICE').length;
  const bk = LISTINGS.filter((x) => x.bookable).length;
  console.log(`✅ ${n} test elanı yaradıldı — ${svc} xidmət, ${bk} bron, barter/icarə/çoxşəkilli daxil.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
