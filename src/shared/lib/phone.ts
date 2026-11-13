// =====================================================================
// 📞 Bangladesh mobile numbers written any way (the same rule as the
//   database's bd_mobiles / bd_phone_problem):
//   Bangla digits, +880 / 880 / 0088 / 00880 / 1711… in front, spaces
//   - . ( ), words, and two numbers in one box ("…, …", "… / …", "… or …")
// =====================================================================

const BN = '০১২৩৪৫৬৭৮৯';

/** ০১৭১১ → 01711 (everything else as it is) */
export function toEnglishDigits(s: string): string {
  return s.replace(/[০-৯]/g, (c) => String(BN.indexOf(c)));
}

function one(digits: string): string | null {
  let d = digits.replace(/\D/g, '').replace(/^00/, '');
  if (/^8800?1[3-9]\d{8}$/.test(d)) d = '0' + d.slice(-10);
  else if (/^1[3-9]\d{8}$/.test(d)) d = '0' + d;
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}

/** Every mobile number in the text, in order (01XXXXXXXXX) */
export function bdMobiles(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const part of toEnglishDigits(text).split(/\s*(?:,|\/|;|\||\n|\s+or\s+|\s+বা\s+)\s*/i)) {
    const d = part.replace(/\D/g, '');
    if (!d) continue;
    if (d.length === 22 && d.startsWith('01') && d.slice(11, 13) === '01') {
      [one(d.slice(0, 11)), one(d.slice(11))].forEach((m) => m && out.push(m));
    } else {
      const m = one(d);
      if (m) out.push(m);
    }
  }
  return out;
}

/** The first mobile number, or null */
export function bdMobile(text: string | null | undefined): string | null {
  return bdMobiles(text)[0] ?? null;
}

/** Why this gets no SMS (null = a good mobile number) */
export function bdPhoneProblem(text: string | null | undefined): string | null {
  if (!text?.trim()) return 'No number';
  if (bdMobile(text)) return null;
  const d = toEnglishDigits(text).replace(/\D/g, '').replace(/^00/, '').replace(/^880?/, '0');
  if (!d) return 'No digits';
  if (!/^0?1/.test(d) && d.length >= 6 && d.length <= 10) return 'Landline (no SMS)';
  if (/^0?1[0-2]/.test(d)) return 'Wrong operator code';
  if (d.length < 11) return `Too short (${d.length} digits)`;
  if (d.length > 11) return `Too long (${d.length} digits)`;
  return 'Not a Bangladesh mobile number';
}
