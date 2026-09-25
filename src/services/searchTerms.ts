// AXTARIŞ SÖZLƏRİ — sorğunu sözlərə bölür və Azərbaycan dilinin şəkilçilərini atır.
//
// Əvvəl axtarış sorğunu OLDUĞU KİMİ (bütöv sətir) `contains` ilə yoxlayırdı:
//   • «kitablar» yazan «Kitab» başlıqlı elanı TAPMIRDI (şəkilçi);
//   • «uşaq kitabı» yazan «Kitab — uşaqlar üçün» elanını TAPMIRDI (söz sırası);
//   • kateqoriya ümumiyyətlə axtarılmırdı: «kitab» sözü başlıqda yoxdursa,
//     «Hobbi › Kitablar» kateqoriyasındakı elan görünmürdü.
//
// İndi: sorğu sözlərə bölünür, hər söz kökünə salınır və HƏR SÖZ sahələrdən
// (başlıq, təsvir, kateqoriya, marka, model, satıcı/mağaza adı, şəhər) ən azı
// birində tapılmalıdır.

// Ən uzundan qısaya — ilk uyğun gələn atılır.
const SUFFIXES = [
  'larında', 'lərində', 'larından', 'lərindən',
  'ların', 'lərin', 'lardan', 'lərdən', 'larda', 'lərdə',
  'ları', 'ləri', 'lar', 'lər',
  'ından', 'indən', 'undan', 'ündən', 'ında', 'ində', 'unda', 'ündə',
  'dan', 'dən', 'nın', 'nin', 'nun', 'nün', 'da', 'də',
  'ın', 'in', 'un', 'ün', 'nı', 'ni', 'nu', 'nü',
  'sı', 'si', 'su', 'sü', // mənsubiyyət: ayaqqabısı → ayaqqabı, maşın qapısı → qapı
  'ı', 'i', 'u', 'ü', 'a', 'ə',
];

// Kökün minimal uzunluğu — daha qısası məna itirir («ev», «su» toxunulmur).
const MIN_STEM = 4;

/** Sözün kökü — bir şəkilçi atılır (məs. kitablar → kitab, telefonu → telefon). */
export function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= MIN_STEM) return w;
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= MIN_STEM && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

/** Sorğunu axtarış sözlərinə çevirir (maks 5 söz, təkrarsız). */
export function searchWords(query: string): string[] {
  const words = String(query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')   // durğu işarələri — boşluq
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 5)
    .map(stemWord);
  return Array.from(new Set(words));
}
