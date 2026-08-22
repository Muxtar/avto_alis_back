/**
 * Kateqoriya taksonomiyası 3 səviyyəli olanda bəzi alt kateqoriyalar birləşdirildi
 * və ya adı dəqiqləşdirildi (təkrar adlar aradan qaldırıldı). Bu skript bazadakı
 * KÖHNƏ dəyərləri yeni yollara çevirir.
 *
 * İşə salmaq:  npx tsx prisma/migrate-categories.ts
 * Yalnız hesabat (dəyişiklik etmədən):  npx tsx prisma/migrate-categories.ts --dry
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

// frontend/src/lib/categories.ts → LEGACY_CAT_MAP ilə eyni olmalıdır.
const MAP: Record<string, string> = {
  'Nəqliyyat › Təkər və disklər': 'Avtomobil ehtiyat hissələri › Təkər, şin və disklər',
  'Avtomobil ehtiyat hissələri › Şinlər və disklər': 'Avtomobil ehtiyat hissələri › Təkər, şin və disklər',
  'Avtomobil ehtiyat hissələri › İşıqlandırma': 'Avtomobil ehtiyat hissələri › Avtomobil işıqlandırması',
  'Avtomobil ehtiyat hissələri › Elektrik və elektronika': 'Avtomobil ehtiyat hissələri › Avtoelektrik və elektronika',
  'Avtomobil ehtiyat hissələri › Audio və multimedia': 'Avtomobil ehtiyat hissələri › Avto audio və multimedia',
  'Ev və bağ › İşıqlandırma': 'Ev və bağ › İşıqlandırma və lampalar',
  'Daşınmaz əmlak › Evlər və villalar': 'Daşınmaz əmlak › Həyət evi, villa və bağ evləri',
  'Daşınmaz əmlak › Həyət evləri və bağ': 'Daşınmaz əmlak › Həyət evi, villa və bağ evləri',
  'Elektronika › Komponentlər və monitorlar': 'Elektronika › Komponentlər və periferiya',
  'Geyim və aksesuar › Uşaq geyimi': 'Uşaq aləmi › Uşaq geyimi',
  'Turizm, istirahət və məkan › Bağ evi və villa (günlük)': 'Turizm, istirahət və məkan › Villa və bağ evi (bron)',
  'Kənd təsərrüfatı › Toxum və bitkilər': 'Kənd təsərrüfatı › Toxum və şitillər',
};

// Çox köhnə (yalnız avto hissələri) taksonomiyası: "Mühərrik > Yağlama > Yağ filtri".
// Ayırıcı " > " idi və heç bir menyu kateqoriyasına uyğun gəlmirdi — ona görə
// belə elanlar saytda kateqoriya seçəndə görünmürdü. Yeni yollara köçürülür.
const P = 'Avtomobil ehtiyat hissələri › ';
const OLD_PARTS: Record<string, string> = {
  'Mühərrik > Yağlama': P + 'Filtrlər və yağlar › Mühərrik yağları',
  'Mühərrik > Filtrlər': P + 'Filtrlər və yağlar',
  'Mühərrik > Alışdırma': P + 'Avtoelektrik və elektronika › Şam və kətüşkalar',
  'Mühərrik > Hava sistemi': P + 'Mühərrik hissələri › Turbinalar',
  'Mühərrik > Klapan': P + 'Mühərrik hissələri › Klapanlar',
  'Mühərrik > Kəmərlər': P + 'Mühərrik hissələri › Vaxt kəməri və zənciri',
  'Mühərrik > Soyutma': P + 'Soyutma və kondisioner',
  'Əyləc > Disk': P + 'Əyləc sistemi › Əyləc diskləri',
  'Əyləc > Kolodka': P + 'Əyləc sistemi › Əyləc kolodkaları',
  'Əyləc > Maye': P + 'Avtokimya və qulluq vasitələri › Əyləc mayesi',
  'Əyləc > Elektronika': P + 'Əyləc sistemi › ABS sensorları',
  'Elektrik > Akkumulyator': P + 'Akkumulyator',
  'Elektrik > Sensor': P + 'Avtoelektrik və elektronika › Sensorlar',
  'Elektrik > Yanacaq sistemi': P + 'Avtoelektrik və elektronika',
  'Elektrik > Yüklənmə': P + 'Avtoelektrik və elektronika › Generatorlar',
  'Elektrik > İşəsalma': P + 'Avtoelektrik və elektronika › Starterlər',
  'İşıqlandırma > Ön': P + 'Avtomobil işıqlandırması › Ön faralar',
  'İşıqlandırma > Arxa': P + 'Avtomobil işıqlandırması › Arxa stop işıqları',
  'İşıqlandırma > Köməkçi': P + 'Avtomobil işıqlandırması › Duman işıqları',
  'İşıqlandırma > Salon': P + 'Salon və aksesuar › Salon işıqlandırması',
  'Asma > Amortizator': P + 'Asqı və sükan › Amortizatorlar',
  'Asma > Rulman': P + 'Asqı və sükan › Podşipniklər',
  'Asma > Sancaq': P + 'Asqı və sükan › Şar barmaqlar',
  'Təkərlər > Disk': P + 'Təkər, şin və disklər › Yüngül lehimli disklər',
  'Təkərlər > Qış': P + 'Təkər, şin və disklər › Qış şinləri',
  'Təkərlər > Yay': P + 'Təkər, şin və disklər › Yay şinləri',
  'Transmissiya > Yağlar': P + 'Filtrlər və yağlar › Transmissiya yağları',
  'Eqzoz > Boru': P + 'Egzoz sistemi › Egzoz boruları',
  'Eqzoz > Katalizator': P + 'Egzoz sistemi › Katalizatorlar',
  'Kuzov > Bufer': P + 'Kuzov hissələri › Bamperlər',
  'Kuzov > Qanad': P + 'Kuzov hissələri › Qanadlar',
  'Kuzov > Güzgü': P + 'Şüşə və güzgülər › Yan güzgülər',
  'Kuzov > Panel': P + 'Salon və aksesuar',
  'Diaqnostika > Skaner': P + 'Avtoelektrik və elektronika › Diaqnostika cihazları',
  'Diaqnostika > Alət': P + 'Avtoelektrik və elektronika › Diaqnostika cihazları',
};

async function main() {
  let total = 0;
  for (const [oldPath, newPath] of Object.entries(MAP)) {
    // Həm dəqiq uyğunluq, həm də 3-cü səviyyəsi olan köhnə dəyərlər (prefiks).
    const rows = await prisma.listing.findMany({
      where: { category: { startsWith: oldPath } },
      select: { id: true, category: true },
    });
    if (!rows.length) continue;
    console.log(`${rows.length.toString().padStart(5)}  ${oldPath}  →  ${newPath}`);
    total += rows.length;
    if (DRY) continue;
    for (const r of rows) {
      await prisma.listing.update({
        where: { id: r.id },
        data: { category: newPath + r.category.slice(oldPath.length) },
      });
    }
  }

  // Köhnə ">" formatlı avto-hissə elanları.
  for (const [oldPrefix, newPath] of Object.entries(OLD_PARTS)) {
    const rows = await prisma.listing.findMany({
      where: { category: { startsWith: oldPrefix } },
      select: { id: true },
    });
    if (!rows.length) continue;
    console.log(`${rows.length.toString().padStart(5)}  ${oldPrefix} …  →  ${newPath}`);
    total += rows.length;
    if (DRY) continue;
    for (const r of rows) {
      await prisma.listing.update({ where: { id: r.id }, data: { category: newPath } });
    }
  }

  console.log(total ? `\n${DRY ? 'Dəyişəcək' : 'Dəyişdirildi'}: ${total} elan` : 'Köhnə kateqoriyalı elan tapılmadı.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
