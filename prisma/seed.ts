import { PrismaClient, UserType, ListingType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const categories = ['Mühərrik', 'Əyləc', 'Elektrik', 'Kuzov', 'Filtrlər', 'İşıqlandırma', 'Texniki xidmət', 'Diaqnostika', 'Digər'];
const conditions = ['NEW', 'USED', 'REFURBISHED'] as const;
const countries = ['Almaniya', 'Türkiyə', 'Çin', 'Yaponiya', 'Koreya', 'ABŞ', 'İtaliya'];
const brands = ['Bosch', 'Brembo', 'NGK', 'Denso', 'Valeo', 'Hella', 'Mann', 'Mahle', 'Febi', 'Lemforder', 'TRW', 'SKF', 'Gates', 'Continental'];
const vehicles = ['BMW E60', 'BMW F10', 'Mercedes W211', 'Mercedes W212', 'Toyota Camry', 'Hyundai Tucson', 'Kia Sportage', 'Nissan Qashqai', 'Volkswagen Passat', 'Audi A4'];

const productNames = [
  'Mühərrik yağı filtri', 'Ön əyləc kolodkası', 'Arxa əyləc diski', 'Generator', 'Starter motor',
  'Radiator', 'Su nasosu', 'Zamanlama kəməri dəsti', 'Hava filtri', 'Salon filtri',
  'Yağ filtri', 'Yanacaq nasosu', 'Oksigen sensoru', 'ABS sensoru', 'Ön amortizator',
  'Arxa amortizator', 'Ön far dəsti', 'Arxa stop işığı', 'Dumanlıq işığı', 'Güzgü sağ',
  'Güzgü sol', 'Ön bufer', 'Arxa bufer', 'Qanad ön sağ', 'Qanad ön sol',
  'Kapot', 'Baqaj qapağı', 'Qapı ön sağ', 'Sveca dəsti 4-lü', 'Katok dəsti',
  'Mühərrik yağı 5W30 4L', 'Antifriz 5L', 'Əyləc mayesi DOT4', 'Sürücü kəməri', 'Termostat',
  'Turbo kompressor', 'Eqzoz borusu', 'Katalizator', 'Sürət qutusu yağı', 'Differensial yağı',
  'Rulman ön təkərlik', 'Sancaq toplusu', 'Yanacaq filtri', 'Klapan qapağı', 'Porşen dəsti',
  'Silindr başlığı', 'Krank valı', 'Eksantrik valı', 'Zəncir dəsti', 'Mühərrik montaj yastığı',
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

  // Create admin: muxtar / 1992
  const adminHash = await bcrypt.hash('1992', 10);
  const admin = await prisma.user.create({
    data: { name: 'muxtar', phone: '+994 50 000 00 00', type: UserType.CAR_OWNER, role: 'ADMIN', password: adminHash, verified: true },
  });
  console.log('Admin yaradildi: muxtar / 1992 (id:', admin.id, ')');

  // Create 10 sellers
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
        workplaces: {
          create: {
            name: `${sellerNames[i].split(' ')[0]} Auto ${i < 4 ? 'Servis' : 'Parts'}`,
            address: `Bakı, ${['Nəsimi', 'Yasamal', 'Səbail', 'Xətai', 'Binəqədi'][i % 5]} r., ${10 + i}-ci küçə`,
          },
        },
      },
    });
    sellers.push(seller);
  }

  // Create 5 buyers
  const buyerNames = ['Murad Tağıyev', 'İlkin Əsgərov', 'Nicat Həsənov', 'Emil Kərimov', 'Zaur Ağayev'];
  const buyers = [];
  for (let i = 0; i < buyerNames.length; i++) {
    const buyer = await prisma.user.create({
      data: {
        name: buyerNames[i],
        phone: `+994 55 ${String(200 + i).padStart(3, '0')} ${String(30 + i * 4).padStart(2, '0')} ${String(40 + i * 5).padStart(2, '0')}`,
        type: UserType.CAR_OWNER,
        verified: true,
        vehicles: {
          create: {
            brand: vehicles[i].split(' ')[0],
            model: vehicles[i].split(' ')[1],
            year: 2015 + i,
            passportImage: '',
          },
        },
      },
    });
    buyers.push(buyer);
  }

  // Create 50 listings
  const listings = [];
  for (let i = 0; i < 50; i++) {
    const seller = sellers[i % sellers.length];
    const isService = i < 4 && seller.type === 'MECHANIC';
    const listing = await prisma.listing.create({
      data: {
        userId: seller.id,
        title: productNames[i],
        description: `${productNames[i]} - yüksək keyfiyyət, orijinal məhsul. ${vehicles[i % vehicles.length]} üçün uyğun. Zəmanətli.`,
        price: parseFloat((Math.random() * 300 + 5).toFixed(2)),
        category: categories[i % categories.length],
        type: isService ? ListingType.SERVICE : ListingType.PRODUCT,
        condition: conditions[i % 3],
        country: countries[i % countries.length],
        brand: brands[i % brands.length],
        stock: Math.floor(Math.random() * 20) + 1,
        forVehicle: vehicles[i % vehicles.length],
        location: 'Bakı',
        phone: seller.phone,
        images: [],
        viewCount: Math.floor(Math.random() * 500),
      },
    });
    listings.push(listing);
  }

  // Create 15 orders with various statuses
  const statuses = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'DELIVERED', 'DELIVERED'] as const;
  for (let i = 0; i < 15; i++) {
    const buyer = buyers[i % buyers.length];
    const listing = listings[i * 3];
    const seller = sellers.find((s) => s.id === listing.userId)!;
    const status = statuses[i % statuses.length];
    const qty = 1 + (i % 3);

    await prisma.order.create({
      data: {
        buyerId: buyer.id,
        sellerId: seller.id,
        status,
        total: listing.price * qty,
        address: `Bakı, ${['Nəsimi', 'Yasamal', 'Səbail', 'Xətai', 'Suraxanı'][i % 5]} r., ${i + 1}-ci küçə, ev ${i + 10}`,
        phone: buyer.phone,
        note: i % 3 === 0 ? 'Zəhmət olmasa tez çatdırın' : null,
        items: {
          create: {
            listingId: listing.id,
            quantity: qty,
            price: listing.price,
            title: listing.title,
          },
        },
      },
    });
  }

  // Create a courier
  const courierHash = await bcrypt.hash('kuryer123', 10);
  await prisma.user.create({
    data: { name: 'Elşən Kuryer', phone: '+994 70 999 99 99', type: UserType.COURIER, role: 'USER', password: courierHash, verified: true },
  });

  console.log('Seed tamamlandı!');
  console.log('- 1 admin (muxtar / 1992)');
  console.log('- 10 satıcı/usta');
  console.log('- 5 alıcı');
  console.log('- 50 məhsul/elan');
  console.log('- 15 sifariş (6 DELIVERED - iadə test üçün)');
  console.log('- 1 kuryer (Elşən Kuryer / +994 70 999 99 99 / kuryer123)');
}

main().catch(console.error).finally(() => prisma.$disconnect());
