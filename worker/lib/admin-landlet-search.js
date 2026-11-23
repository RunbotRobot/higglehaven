// #4074: the admin dashboard finds a lándlet by its name, its id or its owner's username, not only by
// pasting an exact id. One admin-only read, bounded: a few alphabetic words become SQL substring tests
// (so the database does the narrowing), then the Worker ranks what came back and applies the numeric
// words itself, because "north ridge 2" has to find "north-ridge-002".
import { json } from './http.js';
import { requireAdmin } from './auth.js';

export const LANDLET_SEARCH_LIMIT = 25; // rows shown; the total found is reported beside them
const SCAN_LIMIT_WITH_WORDS = 500; // rows the database hands back when at least one word narrows it
const SCAN_LIMIT_NUMBERS_ONLY = 2000; // a query of only numbers cannot be narrowed in SQL
const MAX_QUERY_LENGTH = 100;

// Lowercase, every run of anything that is not a letter or digit becomes one space, so "Central-Mosaic 2",
// "central mosaic 2" and "central_mosaic_2" all read the same.
export function searchWords(query) {
  const cleaned = String(query ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return cleaned ? cleaned.split(' ').slice(0, 8) : [];
}

const isNumber = (word) => /^[0-9]+$/.test(word);
const stripZeros = (digits) => digits.replace(/^0+(?=\d)/, '');

// Does the haystack (already split into words) contain this number, whatever its leading zeros, or a
// number that starts with it ("1" finds 12 and 100; "2" finds 002)?
function hasNumber(haystackWords, word) {
  const wanted = stripZeros(word);
  return haystackWords.some((w) => isNumber(w) && stripZeros(w).startsWith(wanted));
}

// Rank one lándlet for the query words: lower is better, null means it does not match. An exact id or
// name beats everything; then every word found in the name, then the id, then the owner.
export function rankLandlet(words, landlet) {
  if (!words.length) return null;
  const idText = searchWords(landlet.landletId).join(' ');
  const nameText = searchWords(landlet.name).join(' ');
  const ownerText = searchWords(landlet.ownerUsername).join(' ');
  const queryText = words.join(' ');
  const parts = [idText, nameText, ownerText];
  const all = parts.join(' ').split(' ').filter(Boolean);
  for (const word of words) {
    if (isNumber(word)) {
      if (!hasNumber(all, word)) return null;
    } else if (!parts.some((p) => p.includes(word))) return null;
  }
  if (queryText === idText) return 0;
  if (queryText === nameText) return 1;
  if (words.every((w) => (isNumber(w) ? hasNumber(nameText.split(' '), w) : nameText.includes(w)))) return 2;
  if (words.every((w) => (isNumber(w) ? hasNumber(idText.split(' '), w) : idText.includes(w)))) return 3;
  return 4;
}

export async function handleAdminLandletSearch(request, db, url) {
  await requireAdmin(request, db);
  const raw = String(url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH);
  const words = searchWords(raw);
  if (!words.length) return json({ query: raw, landlets: [], total: 0, shown: 0 });

  // Alphabetic words narrow in SQL (substring over id, name, owner username); numeric words are applied below.
  const textWords = words.filter((w) => !isNumber(w));
  const clauses = textWords.map((_, i) => `(instr(lower(landlets.landlet_id), ?${i + 1}) > 0
      OR instr(lower(landlets.name), ?${i + 1}) > 0
      OR instr(lower(coalesce(users.username, '')), ?${i + 1}) > 0)`);
  const limit = textWords.length ? SCAN_LIMIT_WITH_WORDS : SCAN_LIMIT_NUMBERS_ONLY;
  const rows = (await db.prepare(`
    SELECT landlets.landlet_id, landlets.name, landlets.status, landlets.area_m2, landlets.owner_builder_id,
      users.username AS owner_username
    FROM landlets
    LEFT JOIN builders ON builders.builder_id = landlets.owner_builder_id
    LEFT JOIN users ON users.user_id = builders.user_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY landlets.landlet_id
    LIMIT ${limit}
  `).bind(...textWords).all()).results;

  const ranked = rows
    .map((row) => {
      const landlet = {
        landletId: row.landlet_id,
        name: row.name,
        status: row.status,
        areaM2: row.area_m2,
        ownerBuilderId: row.owner_builder_id ?? null,
        ownerUsername: row.owner_username ?? null,
      };
      return { landlet, rank: rankLandlet(words, landlet) };
    })
    .filter((entry) => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.landlet.landletId.localeCompare(b.landlet.landletId));

  return json({
    query: raw,
    total: ranked.length,
    shown: Math.min(ranked.length, LANDLET_SEARCH_LIMIT),
    // True when the database stopped handing rows back before the end, so the count may be higher.
    scanCapped: rows.length >= limit,
    landlets: ranked.slice(0, LANDLET_SEARCH_LIMIT).map((entry) => entry.landlet),
  });
}
