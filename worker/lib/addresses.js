// #4598 (Shipping 1/8, part of #4394): a person's addresses, kept on the account. Read and written only by the person
// they belong to (every route is behind a current session and filters on its own user_id); a later piece copies one
// onto an order for that order's buyer and seller. The server decides everything and says which field is wrong and why.
import { json, HttpError } from './http.js';
import { readJson } from './validation.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser } from './auth.js';
import { isKnownCountryCode, countryChoices } from './country-codes.js';

export const MAX_ADDRESSES_PER_ACCOUNT = 10;
const ADDRESS_MUTATE_RATE_LIMIT_MAX = 30;

// Countries whose address is not complete without a state, province or region.
const REGION_REQUIRED = new Set(['US', 'CA', 'AU']);

const FIELD_LIMITS = { recipientName: 100, line1: 120, line2: 120, city: 80, region: 80, postalCode: 12, phone: 20 };

function text(value, field, label, { required = false } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw new HttpError(`${label} is required`, 400, { field });
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(`${label} must be text`, 400, { field });
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > FIELD_LIMITS[field]) {
    throw new HttpError(`${label} must be ${FIELD_LIMITS[field]} characters or fewer`, 400, { field });
  }
  return trimmed;
}

// A light check by country, only to catch a typo: the carrier is the real judge.
function checkPostalCode(postalCode, country) {
  const ok = country === 'US' ? /^\d{5}(-\d{4})?$/.test(postalCode)
    : country === 'CA' ? /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(postalCode)
      : /^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/.test(postalCode);
  if (!ok) {
    const hint = country === 'US' ? ' (5 digits, like 98101)' : country === 'CA' ? ' (like K1A 0B1)' : '';
    throw new HttpError(`That postal code does not look right for this country${hint}`, 400, { field: 'postalCode' });
  }
}

// Validates a whole address (an edit sends the whole thing, so one rule covers add and edit).
export function validateAddress(input) {
  if (!input || typeof input !== 'object') throw new HttpError('An address is required', 400);
  const recipientName = text(input.recipientName, 'recipientName', 'Recipient name', { required: true });
  const line1 = text(input.line1, 'line1', 'Address line 1', { required: true });
  const line2 = text(input.line2, 'line2', 'Address line 2');
  const city = text(input.city, 'city', 'City', { required: true });
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!country) throw new HttpError('Country is required', 400, { field: 'country' });
  if (!isKnownCountryCode(country)) throw new HttpError('Country must be a two-letter country code', 400, { field: 'country' });
  const region = text(input.region, 'region', 'State or region', { required: REGION_REQUIRED.has(country) });
  const postalCode = text(input.postalCode, 'postalCode', 'Postal code', { required: true });
  checkPostalCode(postalCode, country);
  const phone = text(input.phone, 'phone', 'Phone');
  if (phone !== null && !/^[+]?[0-9 ()-]{5,20}$/.test(phone)) {
    throw new HttpError('Phone can only hold digits, spaces, + ( ) and -', 400, { field: 'phone' });
  }
  return { recipientName, line1, line2, city, region, postalCode: postalCode.toUpperCase(), country, phone };
}

export function addressFromRow(row) {
  return {
    addressId: row.address_id,
    recipientName: row.recipient_name,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    phone: row.phone,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listFor(db, userId) {
  const { results } = await db.prepare(
    'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at ASC, address_id',
  ).bind(userId).all();
  return results.map(addressFromRow);
}

// GET/POST /api/addresses, PATCH/DELETE /api/addresses/:id, POST /api/addresses/:id/default.
export async function handleAddresses(request, db, route) {
  const user = await requireCurrentUser(request, db);

  if (request.method === 'GET' && route.length === 1) {
    return json({ addresses: await listFor(db, user.user_id), maxAddresses: MAX_ADDRESSES_PER_ACCOUNT, regionRequiredFor: [...REGION_REQUIRED], countries: countryChoices() });
  }

  if (request.method === 'POST' && route.length === 1) {
    await checkRateLimit(db, `address-mutate:${user.user_id}`, ADDRESS_MUTATE_RATE_LIMIT_MAX);
    const address = validateAddress(await readJson(request));
    const addressId = `addr-${crypto.randomUUID()}`;
    // One statement: the cap and "the first address is the default" are decided by the INSERT itself, so two
    // requests at once cannot both slip under the cap or both claim the default.
    const result = await db.prepare(`
      INSERT INTO user_addresses (address_id, user_id, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        CASE WHEN EXISTS (SELECT 1 FROM user_addresses WHERE user_id = ?2) THEN 0 ELSE 1 END
      WHERE (SELECT COUNT(*) FROM user_addresses WHERE user_id = ?2) < ?11
    `).bind(addressId, user.user_id, address.recipientName, address.line1, address.line2, address.city,
      address.region, address.postalCode, address.country, address.phone, MAX_ADDRESSES_PER_ACCOUNT).run();
    if (result.meta.changes === 0) {
      throw new HttpError(`You can keep up to ${MAX_ADDRESSES_PER_ACCOUNT} addresses. Remove one to add another.`, 409,
        { limit: MAX_ADDRESSES_PER_ACCOUNT });
    }
    const row = await db.prepare('SELECT * FROM user_addresses WHERE address_id = ?').bind(addressId).first();
    return json({ address: addressFromRow(row) }, 201);
  }

  if (route.length >= 2) {
    const addressId = route[1];
    const owned = await db.prepare('SELECT address_id, is_default FROM user_addresses WHERE address_id = ? AND user_id = ?')
      .bind(addressId, user.user_id).first();
    // Someone else's address answers exactly like one that does not exist.
    if (!owned) throw new HttpError('Address not found', 404);

    if (request.method === 'PATCH' && route.length === 2) {
      await checkRateLimit(db, `address-mutate:${user.user_id}`, ADDRESS_MUTATE_RATE_LIMIT_MAX);
      const address = validateAddress(await readJson(request));
      await db.prepare(`
        UPDATE user_addresses SET recipient_name = ?, line1 = ?, line2 = ?, city = ?, region = ?, postal_code = ?,
          country = ?, phone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE address_id = ? AND user_id = ?
      `).bind(address.recipientName, address.line1, address.line2, address.city, address.region, address.postalCode,
        address.country, address.phone, addressId, user.user_id).run();
      const row = await db.prepare('SELECT * FROM user_addresses WHERE address_id = ?').bind(addressId).first();
      return json({ address: addressFromRow(row) });
    }

    if (request.method === 'DELETE' && route.length === 2) {
      await checkRateLimit(db, `address-mutate:${user.user_id}`, ADDRESS_MUTATE_RATE_LIMIT_MAX);
      // Removing the default hands the default to the oldest one left, in the same batch, so a person who has
      // addresses always has a default.
      await db.batch([
        db.prepare('DELETE FROM user_addresses WHERE address_id = ? AND user_id = ?').bind(addressId, user.user_id),
        db.prepare(`
          UPDATE user_addresses SET is_default = 1
          WHERE address_id = (SELECT address_id FROM user_addresses WHERE user_id = ?1 ORDER BY created_at ASC, address_id LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM user_addresses WHERE user_id = ?1 AND is_default = 1)
        `).bind(user.user_id),
      ]);
      return json({ removed: true });
    }

    if (request.method === 'POST' && route.length === 3 && route[2] === 'default') {
      await checkRateLimit(db, `address-mutate:${user.user_id}`, ADDRESS_MUTATE_RATE_LIMIT_MAX);
      await db.batch([
        db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ? AND address_id != ?').bind(user.user_id, addressId),
        db.prepare('UPDATE user_addresses SET is_default = 1 WHERE address_id = ? AND user_id = ?').bind(addressId, user.user_id),
      ]);
      return json({ addresses: await listFor(db, user.user_id) });
    }
  }

  return json({ error: 'Not found' }, 404);
}
