import { PrismaClient, UserType, ListingType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const conditions = ['NEW', 'USED', 'REFURBISHED'] as const;
const fuelTypes = ['GASOLINE', 'DIESEL', 'HYBRID', 'ELECTRIC', 'GAS'] as const;
const paymentTypes = ['CASH', 'CREDIT', 'BOTH'] as const;
const countries = ['Almaniya', 'Türkiyə', 'Çin', 'Yaponiya', 'Koreya', 'ABŞ', 'İtaliya'];
const cities = ['Bakı', 'Sumqayıt', 'Gəncə', 'Mingəçevir', 'Şirvan', 'Lənkəran', 'Şəki', 'Quba', 'Xırdalan', 'Yevlax'];
const brands = ['Bosch', 'Brembo', 'NGK', 'Denso', 'Valeo', 'Hella', 'Mann', 'Mahle', 'Febi', 'Lemforder', 'TRW', 'SKF', 'Gates', 'Continental'];
const carBrandModels = [
  { brand: 'BMW', model: 'E60' }, { brand: 'BMW', model: 'F10' },
  { brand: 'Mercedes', model: 'W211' }, { brand: 'Mercedes', model: 'W212' },
  { brand: 'Toyota', model: 'Camry' }, { brand: 'Hyundai', model: 'Tucson' },
  { brand: 'Kia', model: 'Sportage' }, { brand: 'Nissan', model: 'Qashqai' },
  { brand: 'Volkswagen', model: 'Passat' }, { brand: 'Audi', model: 'A4' },
  { brand: 'Honda', model: 'Civic' }, { brand: 'Mazda', model: 'CX-5' },
];

// Hər məhsul: ad, kateqoriya yolu, və Unsplash şəkil URL-i
// Bütün şəkillər avtomobil/hissə tematikalıdır (Unsplash CDN, açıq lisenziya)
const products = [
  // Mühərrik və ehtiyat hissələr
  { name: 'Mühərrik yağı filtri', cat: 'Mühərrik > Yağlama > Yağ filtri', img: 'https://images.unsplash.com/photo-1486006920555-c77dcf18193c?w=800&q=80' },
  { name: 'Hava filtri', cat: 'Mühərrik > Filtrlər > Hava filtri', img: 'https://images.unsplash.com/photo-1632823471565-1ecdf5c6d7fa?w=800&q=80' },
  { name: 'Salon filtri', cat: 'Mühərrik > Filtrlər > Salon filtri', img: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=80' },
  { name: 'Yanacaq filtri', cat: 'Mühərrik > Filtrlər > Yanacaq filtri', img: 'https://images.unsplash.com/photo-1493238792000-8113da705763?w=800&q=80' },
  { name: 'Sveca dəsti 4-lü', cat: 'Mühərrik > Alışdırma > Şamlar', img: 'https://images.unsplash.com/photo-1597007030739-6d2e7172ee6f?w=800&q=80' },
  { name: 'Mühərrik yağı 5W30 4L', cat: 'Mühərrik > Yağlama > Mühərrik yağı', img: 'https://images.unsplash.com/photo-1635269569361-fa5f37f6dc5b?w=800&q=80' },
  { name: 'Antifriz 5L', cat: 'Mühərrik > Soyutma > Antifriz', img: 'https://images.unsplash.com/photo-1606577924006-27d39b132ae2?w=800&q=80' },
  { name: 'Termostat', cat: 'Mühərrik > Soyutma > Termostat', img: 'https://images.unsplash.com/photo-1635007050593-cee7be2dac28?w=800&q=80' },
  { name: 'Su nasosu', cat: 'Mühərrik > Soyutma > Su nasosu', img: 'https://images.unsplash.com/photo-1518641070075-f76f48d75ce5?w=800&q=80' },
  { name: 'Radiator', cat: 'Mühərrik > Soyutma > Radiator', img: 'https://images.unsplash.com/photo-1507035895480-2b3156c31fc8?w=800&q=80' },
  { name: 'Turbo kompressor', cat: 'Mühərrik > Hava sistemi > Turbo', img: 'https://images.unsplash.com/photo-1486754735734-325b5831c3ad?w=800&q=80' },
  { name: 'Zamanlama kəməri dəsti', cat: 'Mühərrik > Kəmərlər > Zamanlama kəməri', img: 'https://images.unsplash.com/photo-1558981852-426c6c22a060?w=800&q=80' },
  { name: 'Sürücü kəməri', cat: 'Mühərrik > Kəmərlər > Yardımçı kəmər', img: 'https://images.unsplash.com/photo-1632823471565-1ecdf5c6d7fa?w=800&q=80' },

  // Əyləc sistemi
  { name: 'Ön əyləc kolodkası', cat: 'Əyləc > Kolodka > Ön', img: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=80' },
  { name: 'Arxa əyləc kolodkası', cat: 'Əyləc > Kolodka > Arxa', img: 'https://images.unsplash.com/photo-1486006920555-c77dcf18193c?w=800&q=80' },
  { name: 'Ön əyləc diski', cat: 'Əyləc > Disk > Ön', img: 'https://images.unsplash.com/photo-1582736317407-371c70b1aa48?w=800&q=80' },
  { name: 'Arxa əyləc diski', cat: 'Əyləc > Disk > Arxa', img: 'https://images.unsplash.com/photo-1542931287-023b922fa89b?w=800&q=80' },
  { name: 'Əyləc mayesi DOT4', cat: 'Əyləc > Maye > DOT4', img: 'https://images.unsplash.com/photo-1635269569361-fa5f37f6dc5b?w=800&q=80' },
  { name: 'ABS sensoru', cat: 'Əyləc > Elektronika > ABS sensoru', img: 'https://images.unsplash.com/photo-1518641070075-f76f48d75ce5?w=800&q=80' },

  // Elektrik
  { name: 'Generator', cat: 'Elektrik > Yüklənmə > Generator', img: 'https://images.unsplash.com/photo-1581094288338-2314dddb7ece?w=800&q=80' },
  { name: 'Starter motor', cat: 'Elektrik > İşəsalma > Starter', img: 'https://images.unsplash.com/photo-1507035895480-2b3156c31fc8?w=800&q=80' },
  { name: 'Akkumulyator 60Ah', cat: 'Elektrik > Akkumulyator > 60Ah', img: 'https://images.unsplash.com/photo-1620714223084-8fcacc6dfd8d?w=800&q=80' },
  { name: 'Akkumulyator 75Ah', cat: 'Elektrik > Akkumulyator > 75Ah', img: 'https://images.unsplash.com/photo-1620714223084-8fcacc6dfd8d?w=800&q=80' },
  { name: 'Oksigen sensoru', cat: 'Elektrik > Sensor > Oksigen', img: 'https://images.unsplash.com/photo-1486754735734-325b5831c3ad?w=800&q=80' },
  { name: 'Yanacaq nasosu', cat: 'Elektrik > Yanacaq sistemi > Nasos', img: 'https://images.unsplash.com/photo-1597007030739-6d2e7172ee6f?w=800&q=80' },

  // İşıqlandırma
  { name: 'Ön far dəsti LED', cat: 'İşıqlandırma > Ön > LED far', img: 'https://images.unsplash.com/photo-1493238792000-8113da705763?w=800&q=80' },
  { name: 'Ön far dəsti Halogen', cat: 'İşıqlandırma > Ön > Halogen', img: 'https://images.unsplash.com/photo-1493238792000-8113da705763?w=800&q=80' },
  { name: 'Arxa stop işığı', cat: 'İşıqlandırma > Arxa > Stop', img: 'https://images.unsplash.com/photo-1542931287-023b922fa89b?w=800&q=80' },
  { name: 'Dumanlıq işığı', cat: 'İşıqlandırma > Köməkçi > Dumanlıq', img: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=80' },
  { name: 'LED salon işığı', cat: 'İşıqlandırma > Salon > LED', img: 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=800&q=80' },

  // Kuzov
  { name: 'Ön bufer', cat: 'Kuzov > Bufer > Ön', img: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=800&q=80' },
  { name: 'Arxa bufer', cat: 'Kuzov > Bufer > Arxa', img: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=80' },
  { name: 'Kapot', cat: 'Kuzov > Panel > Kapot', img: 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=800&q=80' },
  { name: 'Qanad ön sağ', cat: 'Kuzov > Qanad > Ön sağ', img: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=800&q=80' },
  { name: 'Qanad ön sol', cat: 'Kuzov > Qanad > Ön sol', img: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=800&q=80' },
  { name: 'Güzgü sağ', cat: 'Kuzov > Güzgü > Sağ', img: 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=800&q=80' },
  { name: 'Güzgü sol', cat: 'Kuzov > Güzgü > Sol', img: 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=800&q=80' },

  // Sürət qutusu və transmissiya
  { name: 'Sürət qutusu yağı', cat: 'Transmissiya > Yağlar > Sürət qutusu yağı', img: 'https://images.unsplash.com/photo-1635269569361-fa5f37f6dc5b?w=800&q=80' },
  { name: 'Differensial yağı', cat: 'Transmissiya > Yağlar > Differensial', img: 'https://images.unsplash.com/photo-1606577924006-27d39b132ae2?w=800&q=80' },
  { name: 'Klapan', cat: 'Mühərrik > Klapan > Klapan', img: 'https://images.unsplash.com/photo-1597007030739-6d2e7172ee6f?w=800&q=80' },

  // Tekerler ve hava
  { name: 'Yay təkər (4 ədəd) 205/55 R16', cat: 'Təkərlər > Yay > 205/55 R16', img: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?w=800&q=80' },
  { name: 'Qış təkər (4 ədəd) 215/60 R17', cat: 'Təkərlər > Qış > 215/60 R17', img: 'https://images.unsplash.com/photo-1581540222194-0def2dda95b8?w=800&q=80' },
  { name: 'Disk (4 ədəd) R17', cat: 'Təkərlər > Disk > R17 alyuminium', img: 'https://images.unsplash.com/photo-1606921231106-f1083329a65c?w=800&q=80' },
  { name: 'Ön amortizator', cat: 'Asma > Amortizator > Ön', img: 'https://images.unsplash.com/photo-1518641070075-f76f48d75ce5?w=800&q=80' },
  { name: 'Arxa amortizator', cat: 'Asma > Amortizator > Arxa', img: 'https://images.unsplash.com/photo-1518641070075-f76f48d75ce5?w=800&q=80' },
  { name: 'Rulman ön təkərlik', cat: 'Asma > Rulman > Ön', img: 'https://images.unsplash.com/photo-1582736317407-371c70b1aa48?w=800&q=80' },
  { name: 'Sancaq toplusu', cat: 'Asma > Sancaq > Top sancaq', img: 'https://images.unsplash.com/photo-1542931287-023b922fa89b?w=800&q=80' },

  // Eqzoz
  { name: 'Eqzoz borusu', cat: 'Eqzoz > Boru > Orta hissə', img: 'https://images.unsplash.com/photo-1603386329225-868f9b1ee6c9?w=800&q=80' },
  { name: 'Katalizator', cat: 'Eqzoz > Katalizator > Universal', img: 'https://images.unsplash.com/photo-1486006920555-c77dcf18193c?w=800&q=80' },

  // Diaqnostika
  { name: 'OBD-II diaqnostika cihazı', cat: 'Diaqnostika > Skaner > OBD-II', img: 'https://images.unsplash.com/photo-1581092446327-9b52bd1570c2?w=800&q=80' },
  { name: 'Multimetr', cat: 'Diaqnostika > Alət > Multimetr', img: 'https://images.unsplash.com/photo-1581092334651-ddf26d9a09d0?w=800&q=80' },
];

async function main() {
  // Clean all data
  await prisma.returnRequest.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.message.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.emailVerification.deleteMany();
  await prisma.verificationCode.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.workplace.deleteMany();
  await prisma.user.deleteMany();

  // Admin
  const adminHash = await bcrypt.hash('1992', 10);
  const admin = await prisma.user.create({
    data: { name: 'muxtar', phone: '+994 50 000 00 00', type: UserType.CAR_OWNER, role: 'ADMIN', password: adminHash, verified: true },
  });
  console.log('Admin yaradildi: muxtar / 1992 (id:', admin.id, ')');

  // 10 satıcı/usta
  const sellerNames = [
    'Cavid Həsənzadə', 'Elvin Məmmədov', 'Samir Əliyev', 'Tural Babayev', 'Rəşad Hüseynov',
    'Farid Quliyev', 'Orxan İsmayılov', 'Kamran Səfərov', 'Vüqar Rəhimov', 'Ceyhun Novruzov',
  ];
  const sellers = [];
  for (let i = 0; i < sellerNames.length; i++) {
    const seller = await prisma.user.create({
      data: {
        name: sellerNames[i],
        phone: `+994 50 ${String(100 + i).padStart(3, '0')} ${String(10 + i * 3).padStart(2, '0')} ${String(20 + i * 7).padStart(2, '0')}`,
        type: i < 4 ? UserType.MECHANIC : UserType.PARTS_SELLER,
        verified: true,
        sellerVerified: true,
        sellerVerifiedAt: new Date(),
        workplaces: {
          create: {
            name: `${sellerNames[i].split(' ')[0]} Auto ${i < 4 ? 'Servis' : 'Parts'}`,
            address: `${cities[i % cities.length]}, ${10 + i}-ci küçə`,
          },
        },
      },
    });
    sellers.push(seller);
  }

  // 5 alıcı (CAR_OWNER) — vehicle ilə
  const buyerNames = ['Murad Tağıyev', 'İlkin Əsgərov', 'Nicat Həsənov', 'Emil Kərimov', 'Zaur Ağayev'];
  const buyers = [];
  for (let i = 0; i < buyerNames.length; i++) {
    const cm = carBrandModels[i];
    const buyer = await prisma.user.create({
      data: {
        name: buyerNames[i],
        phone: `+994 55 ${String(200 + i).padStart(3, '0')} ${String(30 + i * 4).padStart(2, '0')} ${String(40 + i * 5).padStart(2, '0')}`,
        type: UserType.CAR_OWNER,
        verified: true,
        vehicles: {
          create: { brand: cm.brand, model: cm.model, year: 2015 + i, passportImage: '' },
        },
      },
    });
    buyers.push(buyer);
  }

  // 50 elan
  const listings = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const seller = sellers[i % sellers.length];
    const cm = carBrandModels[i % carBrandModels.length];
    const isService = i % 17 === 0 && seller.type === 'MECHANIC';
    const listing = await prisma.listing.create({
      data: {
        userId: seller.id,
        title: p.name,
        description: `${p.name} — yüksək keyfiyyət, orijinal məhsul. ${cm.brand} ${cm.model} üçün uyğun. Zəmanətli.`,
        price: parseFloat((Math.random() * 300 + 5).toFixed(2)),
        category: p.cat,
        type: isService ? ListingType.SERVICE : ListingType.PRODUCT,
        condition: conditions[i % 3],
        country: countries[i % countries.length],
        brand: brands[i % brands.length],
        stock: Math.floor(Math.random() * 20) + 1,
        forVehicle: `${cm.brand} ${cm.model}`,
        location: cities[i % cities.length],
        phone: seller.phone,
        images: [p.img],
        viewCount: Math.floor(Math.random() * 500),
        // Yeni sahələr
        year: 2010 + (i % 15),
        model: cm.model,
        city: cities[i % cities.length],
        fuelType: fuelTypes[i % fuelTypes.length] as any,
        paymentType: paymentTypes[i % paymentTypes.length] as any,
      },
    });
    listings.push(listing);
  }

  // 15 sifariş
  const statuses = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'DELIVERED', 'DELIVERED'] as const;
  for (let i = 0; i < 15; i++) {
    const buyer = buyers[i % buyers.length];
    const listing = listings[i * 3];
    const seller = sellers.find((s) => s.id === listing.userId)!;
    const status = statuses[i % statuses.length];
    const qty = 1 + (i % 3);
    await prisma.order.create({
      data: {
        buyerId: buyer.id, sellerId: seller.id, status,
        total: listing.price * qty,
        address: `${cities[i % cities.length]}, ${i + 1}-ci küçə, ev ${i + 10}`,
        phone: buyer.phone,
        note: i % 3 === 0 ? 'Zəhmət olmasa tez çatdırın' : null,
        items: { create: { listingId: listing.id, quantity: qty, price: listing.price, title: listing.title } },
      },
    });
  }

  // Kuryer
  const courierHash = await bcrypt.hash('kuryer123', 10);
  await prisma.user.create({
    data: { name: 'Elşən Kuryer', phone: '+994 70 999 99 99', type: UserType.COURIER, role: 'USER', password: courierHash, verified: true },
  });

  console.log('✅ Seed tamamlandı:');
  console.log(`- 1 admin (muxtar / 1992)`);
  console.log(`- 10 satıcı/usta (sellerVerified)`);
  console.log(`- 5 alıcı + avtomobil`);
  console.log(`- ${products.length} məhsul (Unsplash şəkilləri ilə)`);
  console.log(`- 15 sifariş`);
  console.log(`- 1 kuryer (kuryer123)`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
