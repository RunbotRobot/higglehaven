// #4598 (Shipping 1/8, part of #4394): a person's own addresses. The routes are behind a session and filter on the
// account itself, the server names the wrong field, at most ten are kept, exactly one is the default, and an address
// goes with the account (deletion) and into the data export.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const HOME = { recipientName: 'Sam Rivera', line1: '12 Pine Street', line2: 'Apt 4', city: 'Seattle', region: 'WA', postalCode: '98101', country: 'US', phone: '+1 206 555 0100' };
const post = (who, body) => api('/addresses', who.session({ method: 'POST', body: JSON.stringify(body) }));

describe('addresses (#4598)', () => {
  it('refuses every route without a session', async () => {
    expect((await api('/addresses')).response.status).toBe(401);
    expect((await api('/addresses', { method: 'POST', body: JSON.stringify(HOME) })).response.status).toBe(401);
  });

  it('adds, lists, edits and removes; the first one is the default', async () => {
    const person = await signupBuilder('address-crud');
    const first = await post(person, HOME);
    expect(first.response.status).toBe(201);
    expect(first.body.address).toMatchObject({ recipientName: 'Sam Rivera', postalCode: '98101', country: 'US', isDefault: true });
    const second = await post(person, { ...HOME, line1: '9 Elm Road', city: 'Portland', region: 'OR', postalCode: '97201' });
    expect(second.body.address.isDefault).toBe(false);

    const list = await api('/addresses', person.session());
    expect(list.body.addresses.map((a) => a.line1)).toEqual(['12 Pine Street', '9 Elm Road']);
    expect(list.body.maxAddresses).toBe(10);

    const edited = await api(`/addresses/${second.body.address.addressId}`, person.session({
      method: 'PATCH', body: JSON.stringify({ ...HOME, line1: '9 Elm Road', city: 'Portland', region: 'OR', postalCode: '97201', line2: '' }),
    }));
    expect(edited.response.status).toBe(200);
    expect(edited.body.address.line2).toBeNull();

    const removed = await api(`/addresses/${first.body.address.addressId}`, person.session({ method: 'DELETE' }));
    expect(removed.response.status).toBe(200);
    const after = await api('/addresses', person.session());
    // Removing the default hands it to the one left.
    expect(after.body.addresses).toHaveLength(1);
    expect(after.body.addresses[0].isDefault).toBe(true);
  });

  it('keeps exactly one default and lets a person move it', async () => {
    const person = await signupBuilder('address-default');
    const a = (await post(person, HOME)).body.address;
    const b = (await post(person, { ...HOME, line1: '1 Oak Lane' })).body.address;
    const moved = await api(`/addresses/${b.addressId}/default`, person.session({ method: 'POST' }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.addresses.map((x) => [x.addressId, x.isDefault])).toEqual([[b.addressId, true], [a.addressId, false]]);
    const defaults = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_addresses WHERE user_id = (SELECT user_id FROM users WHERE email = ?) AND is_default = 1').bind(person.email).first();
    expect(defaults.n).toBe(1);
  });

  it('says which field is wrong and why', async () => {
    const person = await signupBuilder('address-validation');
    const cases = [
      [{ ...HOME, recipientName: '' }, 'recipientName', /Recipient name is required/],
      [{ ...HOME, line1: '   ' }, 'line1', /Address line 1 is required/],
      [{ ...HOME, city: undefined }, 'city', /City is required/],
      [{ ...HOME, region: '' }, 'region', /State or region is required/],
      [{ ...HOME, postalCode: '9810' }, 'postalCode', /postal code does not look right/],
      [{ ...HOME, country: 'ZZ' }, 'country', /two-letter country code/],
      [{ ...HOME, country: '' }, 'country', /Country is required/],
      [{ ...HOME, phone: 'call me' }, 'phone', /Phone can only hold/],
      [{ ...HOME, line1: 'x'.repeat(121) }, 'line1', /120 characters or fewer/],
    ];
    for (const [body, field, message] of cases) {
      const result = await post(person, body);
      expect(result.response.status, field).toBe(400);
      expect(result.body.error).toMatch(message);
      expect(result.body.field).toBe(field);
    }
    expect((await api('/addresses', person.session())).body.addresses).toEqual([]);
  });

  it('takes a country that needs no region without one, and checks a Canadian postal code', async () => {
    const person = await signupBuilder('address-countries');
    const de = await post(person, { recipientName: 'Jan', line1: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', country: 'de' });
    expect(de.response.status).toBe(201);
    expect(de.body.address).toMatchObject({ country: 'DE', region: null });
    expect((await post(person, { ...HOME, region: 'ON', postalCode: 'K1A 0B1', country: 'CA' })).response.status).toBe(201);
    expect((await post(person, { ...HOME, region: 'ON', postalCode: '12345', country: 'CA' })).response.status).toBe(400);
  });

  it('keeps at most ten, and says so', async () => {
    const person = await signupBuilder('address-cap');
    for (let i = 0; i < 10; i += 1) {
      expect((await post(person, { ...HOME, line1: `${i + 1} Cap Street` })).response.status).toBe(201);
    }
    const eleventh = await post(person, HOME);
    expect(eleventh.response.status).toBe(409);
    expect(eleventh.body.error).toMatch(/up to 10 addresses/);
  });

  it("answers someone else's address exactly like one that does not exist", async () => {
    const owner = await signupBuilder('address-owner');
    const other = await signupBuilder('address-other');
    const address = (await post(owner, HOME)).body.address;
    const edit = await api(`/addresses/${address.addressId}`, other.session({ method: 'PATCH', body: JSON.stringify(HOME) }));
    const remove = await api(`/addresses/${address.addressId}`, other.session({ method: 'DELETE' }));
    const makeDefault = await api(`/addresses/${address.addressId}/default`, other.session({ method: 'POST' }));
    const missing = await api('/addresses/addr-nothing', other.session({ method: 'DELETE' }));
    for (const result of [edit, remove, makeDefault]) {
      expect(result.response.status).toBe(404);
      expect(result.body).toEqual(missing.body);
    }
    expect((await api('/addresses', other.session())).body.addresses).toEqual([]);
    expect((await api('/addresses', owner.session())).body.addresses).toHaveLength(1);
  });

  it('is in the data export, and goes when the account is deleted', async () => {
    const person = await signupBuilder('address-export-delete');
    await post(person, HOME);
    const exported = await api('/auth/export-data', person.session());
    expect(exported.body.communication.addresses).toHaveLength(1);
    expect(exported.body.communication.addresses[0]).toMatchObject({ recipientName: 'Sam Rivera', line1: '12 Pine Street' });

    const deleted = await api('/auth/delete-account', person.session({
      method: 'POST', body: JSON.stringify({ password: 'a fine long password here' }),
    }));
    expect(deleted.response.status).toBe(200);
    const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_addresses WHERE address_id = ?').bind(exported.body.communication.addresses[0].addressId).first();
    expect(stillThere.n).toBe(0);
  });
});
