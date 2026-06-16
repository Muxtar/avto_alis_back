// 30 müxtəlif kateqoriyalı test elanı (məhsul + xidmət).
// İşə salmaq:  DATABASE_URL="<railway-public-url>" npx tsx prisma/seed-test-listings.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const CITIES = ['Bakı', 'Gəncə', 'Sumqayıt', 'Mingəçevir', 'Şəki', 'Lənkəran'];
const pick = <T,>(a: T[], i: number) => a[i % a.length];

type Seed = { title: string; category: string; type: 'PRODUCT' | 'SERVICE'; price: number; brand?: string; desc: string };

const LISTINGS: Seed[] = [
  // Nəqliyyat
  { title: 'Toyota Camry 2019', category: 'Nəqliyyat › Minik avtomobilləri', type: 'PRODUCT', price: 32000, brand: 'Toyota', desc: 'Tam baxımlı, qəzasız.' },
  { title: 'Honda PCX 150 skuter', category: 'Nəqliyyat › Motosiklet və mopedlər', type: 'PRODUCT', price: 4500, brand: 'Honda', desc: 'Az işlənmiş skuter.' },
  // Avtomobil ehtiyat hissələri
  { title: 'Bosch əyləc diski', category: 'Avtomobil ehtiyat hissələri › Əyləc sistemi', type: 'PRODUCT', price: 65, brand: 'Bosch', desc: 'Ön əyləc diski, original.' },
  { title: 'Mahle hava filtri', category: 'Avtomobil ehtiyat hissələri › Filtrlər və yağlar', type: 'PRODUCT', price: 18, brand: 'Mahle', desc: 'Universal hava filtri.' },
  // Daşınmaz əmlak
  { title: '2 otaqlı mənzil, Nizami', category: 'Daşınmaz əmlak › Mənzillər (yeni tikili)', type: 'PRODUCT', price: 95000, desc: 'Təmirli, sənədli mənzil.' },
  { title: 'Həyət evi, Mərdəkan', category: 'Daşınmaz əmlak › Evlər və villalar', type: 'PRODUCT', price: 180000, desc: '4 otaqlı həyət evi.' },
  // Elektronika
  { title: 'iPhone 14 Pro 128GB', category: 'Elektronika › Telefonlar', type: 'PRODUCT', price: 1800, brand: 'Apple', desc: 'İdeal vəziyyətdə.' },
  { title: 'Lenovo IdeaPad noutbuk', category: 'Elektronika › Noutbuklar', type: 'PRODUCT', price: 950, brand: 'Lenovo', desc: 'i5, 16GB RAM, SSD.' },
  { title: 'Samsung 55" TV', category: 'Elektronika › TV və proyektorlar', type: 'PRODUCT', price: 1100, brand: 'Samsung', desc: '4K Smart TV.' },
  // Məişət texnikası
  { title: 'Bosch soyuducu', category: 'Məişət texnikası › Soyuducular', type: 'PRODUCT', price: 850, brand: 'Bosch', desc: 'No Frost, 2 kameralı.' },
  { title: 'Philips blender', category: 'Məişət texnikası › Mətbəx texnikası', type: 'PRODUCT', price: 75, brand: 'Philips', desc: '700W güclü blender.' },
  // Ev və bağ
  { title: 'Künc divan', category: 'Ev və bağ › Mebel', type: 'PRODUCT', price: 600, desc: 'Açılan künc divan.' },
  { title: 'Əl işi xalça 2x3', category: 'Ev və bağ › Xalça və tekstil', type: 'PRODUCT', price: 320, desc: 'Yun xalça.' },
  // Tikinti və təmir
  { title: 'Makita drel', category: 'Tikinti və təmir › Alət və avadanlıq', type: 'PRODUCT', price: 140, brand: 'Makita', desc: 'Şarjlı drel, 2 batareya.' },
  { title: 'Sement (50kq) topdan', category: 'Tikinti və təmir › Sement, qum, kərpic', type: 'PRODUCT', price: 12, desc: 'Portland sement.' },
  // Geyim və aksesuar
  { title: 'Kişi dəri gödəkçə', category: 'Geyim və aksesuar › Kişi geyimi', type: 'PRODUCT', price: 130, desc: 'Original dəri.' },
  { title: 'Qadın çantası', category: 'Geyim və aksesuar › Çantalar', type: 'PRODUCT', price: 85, desc: 'Yeni model çanta.' },
  { title: 'Nike Air Max krossovka', category: 'Geyim və aksesuar › Ayaqqabı', type: 'PRODUCT', price: 160, brand: 'Nike', desc: '42 ölçü.' },
  // Gözəllik və sağlamlıq
  { title: 'Dior ətir 100ml', category: 'Gözəllik və sağlamlıq › Ətriyyat', type: 'PRODUCT', price: 190, brand: 'Dior', desc: 'Original ətir.' },
  // Uşaq aləmi
  { title: 'Uşaq arabası 3in1', category: 'Uşaq aləmi › Uşaq arabaları', type: 'PRODUCT', price: 280, desc: 'Tam komplekt.' },
  { title: 'Lego konstruktor dəsti', category: 'Uşaq aləmi › Oyuncaqlar', type: 'PRODUCT', price: 60, brand: 'Lego', desc: '500+ detal.' },
  // Hobbi və idman
  { title: 'Velosiped 26"', category: 'Hobbi və idman › Velosipedlər', type: 'PRODUCT', price: 240, desc: 'Dağ velosipedi.' },
  { title: 'Yamaha akustik gitara', category: 'Hobbi və idman › Musiqi alətləri', type: 'PRODUCT', price: 210, brand: 'Yamaha', desc: 'Yeni simlərlə.' },
  // Heyvanlar
  { title: 'Alman çoban iti balası', category: 'Heyvanlar › İtlər', type: 'PRODUCT', price: 400, desc: 'Sənədli, peyvəndli.' },
  // Kənd təsərrüfatı
  { title: 'Təbii arı balı 1kq', category: 'Kənd təsərrüfatı › Məhsullar (bal, meyvə)', type: 'PRODUCT', price: 25, desc: 'Dağ balı.' },

  // ===== XİDMƏTLƏR =====
  { title: 'Avtomobil diaqnostikası', category: 'Xidmətlər › Avtomobil xidmətləri', type: 'SERVICE', price: 30, desc: 'Kompüter diaqnostikası, bütün markalar.' },
  { title: 'Mənzil təmiri (anbar açar)', category: 'Xidmətlər › Təmir və tikinti xidmətləri', type: 'SERVICE', price: 0, desc: 'Tam təmir, m² ilə razılaşma.' },
  { title: 'Soyuducu təmiri evdə', category: 'Xidmətlər › Məişət texnikası təmiri', type: 'SERVICE', price: 20, desc: 'Yerində təmir, zəmanətlə.' },
  { title: 'İngilis dili repetitoru', category: 'Xidmətlər › Təhsil və repetitor', type: 'SERVICE', price: 15, desc: 'Fərdi dərslər, onlayn/oflayn.' },
  { title: 'Sayt və mobil tətbiq hazırlanması', category: 'Xidmətlər › Veb sayt və dizayn', type: 'SERVICE', price: 500, desc: 'Peşəkar veb/mobil həllər.' },
];

async function main() {
  // Elanları sahiblənəcək satıcı — varsa ilk istifadəçi, yoxsa yeni yarat.
  // `select` ilə yalnız köhnə sütunları oxuyuruq (schema drift-ə qarşı dayanıqlı).
  const sel = { id: true, name: true, phone: true } as const;
  let seller = await prisma.user.findFirst({ where: { role: 'USER' }, orderBy: { id: 'asc' }, select: sel });
  if (!seller) {
    seller = await prisma.user.create({
      data: { name: 'Test Satıcı', phone: '+994500000000', type: 'PARTS_SELLER', profileComplete: true, verified: true },
      select: sel,
    });
  }
  console.log(`Satıcı: #${seller.id} (${seller.name || seller.phone})`);

  // İdempotent: əvvəlki test elanlarını (eyni başlıqlı) sil, sonra yenidən yarat.
  const titles = LISTINGS.map((l) => l.title);
  const del = await prisma.listing.deleteMany({ where: { userId: seller.id, title: { in: titles } } });
  if (del.count > 0) console.log(`Köhnə test elanları silindi: ${del.count}`);

  const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  let n = 0;
  for (let i = 0; i < LISTINGS.length; i++) {
    const l = LISTINGS[i];
    // Stabil demo şəkil (picsum — real foto, etibarlı CDN). 1 şəkil hər elana.
    const img = `https://picsum.photos/seed/tradixai-${i + 1}/600/450`;
    await prisma.listing.create({
      data: {
        userId: seller.id,
        title: l.title,
        description: l.desc,
        price: l.price,
        category: l.category,
        type: l.type,
        images: [img],
        condition: 'NEW',
        brand: l.brand || null,
        stock: l.type === 'SERVICE' ? 1 : 10,
        city: pick(CITIES, i),
        expiresAt,
      },
      select: { id: true },
    });
    n++;
  }
  console.log(`✅ ${n} test elanı yaradıldı (${LISTINGS.filter((x) => x.type === 'SERVICE').length} xidmət daxil).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
