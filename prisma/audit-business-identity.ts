/**
 * Bizneslə profil təsdiqi arasındakı UYĞUNSUZLUQLARI tapır.
 *
 * Niyə lazımdır: "biznes yalnız təsdiqlənmiş profillə yaradıla bilər" qaydası
 * sonradan sərtləşdirilib. Ondan əvvəl yaradılmış bizneslərdə sahibin statusu
 * PENDING/boş ola bilər. Həmçinin istifadəçi biznes yaradandan sonra profildən
 * «Təsdiqi sil» basa bilirdi — status silinir, FIN/doğum/cins isə qalırdı və
 * admin panelində "təsdiqlənməyib" yazısı ilə dolu məlumat yan-yana görünürdü.
 * (Hər iki yol artıq bağlanıb — bu skript KÖHNƏ sətirləri göstərir.)
 *
 * İşə salmaq:            npx tsx prisma/audit-business-identity.ts
 * Köhnə qalıqları təmizlə: npx tsx prisma/audit-business-identity.ts --fix-stale
 *   (yalnız heç bir doğrulama izi qalmayan profillərdə FIN/doğum/cins silinir)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FIX = process.argv.includes('--fix-stale');

async function main() {
  // 1) Sahibinin kimliyi təsdiqsiz olan CANLI bizneslər
  const bizzes = await prisma.business.findMany({
    where: { deletedAt: null, user: { idVerifyStatus: { not: 'APPROVED' } } },
    select: {
      id: true, name: true, voen: true, status: true, createdAt: true,
      user: { select: { id: true, name: true, phone: true, publicId: true, idVerifyStatus: true, idNumber: true, birthDate: true, idCardImage: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n=== Sahibinin kimliyi təsdiqsiz olan bizneslər: ${bizzes.length} ===`);
  for (const b of bizzes) {
    const u = b.user;
    console.log(
      `#${b.id} ${b.status.padEnd(8)} «${b.name || '—'}» VÖEN:${b.voen || '—'} | ` +
      `sahibi: ${u.name || '—'} (${u.publicId || u.id}, ${u.phone || '—'}) | ` +
      `status: ${u.idVerifyStatus || 'yoxdur'} | FIN: ${u.idNumber || '—'} | ` +
      `sənəd şəkli: ${u.idCardImage ? 'var' : 'yox'} | yaradılıb: ${b.createdAt.toISOString().slice(0, 10)}`,
    );
  }

  // 2) Doğrulaması olmadığı halda təsdiqlənmiş məlumatı qalan profillər
  const stale = await prisma.user.findMany({
    where: {
      idVerifyStatus: null,
      idCardImage: null,
      OR: [{ idNumber: { not: null } }, { birthDate: { not: null } }, { gender: { not: null } }],
    },
    select: { id: true, name: true, phone: true, idNumber: true, birthDate: true, gender: true },
  });
  console.log(`\n=== Doğrulaması silinib, amma FIN/doğum/cins qalıb: ${stale.length} profil ===`);
  for (const u of stale) {
    console.log(`user ${u.id} ${u.name || '—'} (${u.phone || '—'}) — FIN: ${u.idNumber || '—'}, doğum: ${u.birthDate ? u.birthDate.toISOString().slice(0, 10) : '—'}, cins: ${u.gender || '—'}`);
  }

  if (FIX && stale.length) {
    const r = await prisma.user.updateMany({
      where: { id: { in: stale.map((u) => u.id) } },
      data: { idNumber: null, birthDate: null, gender: null },
    });
    console.log(`\n${r.count} profildə köhnə kimlik məlumatı təmizləndi.`);
  } else if (stale.length) {
    console.log('\nTəmizləmək üçün: npx tsx prisma/audit-business-identity.ts --fix-stale');
  }

  console.log(
    bizzes.length
      ? '\nTÖVSİYƏ: yuxarıdakı bizneslərin sahiblərindən Veriff doğrulaması tələb edin. ' +
        'Admin paneldə «⚠ Sahibi təsdiqsiz» süzgəci ilə eyni siyahını görə bilərsiniz. ' +
        'Təsdiq düyməsi indi xəbərdarlıq verir (yalnız təsdiqləyəndən sonra keçir).'
      : '\nUyğunsuzluq tapılmadı.',
  );
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
