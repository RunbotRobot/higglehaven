// #4602 (Shipping 5/8, part of #4394): where "ships to me" is judged from, and the dim switch. The default address's
// country wins, a chosen country stands in when there is no address, the switch is off until turned on, and it is the
// account's own.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const HOME = { recipientName: 'Sam Rivera', line1: '12 Pine Street', city: 'Seattle', region: 'WA', postalCode: '98101', country: 'US' };
const put = (who, body) => api('/shipping-destination', who.session({ method: 'PUT', body: JSON.stringify(body) }));

describe('shipping destination (#4602)', () => {
  it('needs a session', async () => {
    expect((await api('/shipping-destination')).response.status).toBe(401);
    expect((await api('/shipping-destination', { method: 'PUT', body: '{}' })).response.status).toBe(401);
  });

  it('starts with no destination and the filter off', async () => {
    const person = await signupBuilder('dest-fresh');
    const { body } = await api('/shipping-destination', person.session());
    expect(body.destination).toEqual({ country: null, source: null, chosenCountry: null, dimUnshippable: false });
    expect(body.countries.length).toBeGreaterThan(0);
  });

  it('uses a chosen country until an address exists, then the default address', async () => {
    const person = await signupBuilder('dest-chosen');
    const chosen = await put(person, { country: 'de' });
    expect(chosen.body.destination).toMatchObject({ country: 'DE', source: 'chosen' });
    await api('/addresses', person.session({ method: 'POST', body: JSON.stringify(HOME) }));
    const withAddress = await api('/shipping-destination', person.session());
    expect(withAddress.body.destination).toMatchObject({ country: 'US', source: 'address', chosenCountry: 'DE' });
    const cleared = await put(person, { country: null });
    expect(cleared.body.destination.chosenCountry).toBeNull();
    expect(cleared.body.destination.country).toBe('US');
  });

  it('remembers the switch and refuses what it cannot read', async () => {
    const person = await signupBuilder('dest-switch');
    expect((await put(person, { dimUnshippable: true })).body.destination.dimUnshippable).toBe(true);
    expect((await api('/shipping-destination', person.session())).body.destination.dimUnshippable).toBe(true);
    const bad = await put(person, { country: 'XX' });
    expect(bad.response.status).toBe(400);
    expect(bad.body.field).toBe('country');
    expect((await put(person, { dimUnshippable: 'yes' })).response.status).toBe(400);
    expect((await put(person, {})).response.status).toBe(400);
  });

  it('is only ever the caller\'s own', async () => {
    const a = await signupBuilder('dest-a');
    const b = await signupBuilder('dest-b');
    await put(a, { country: 'FR', dimUnshippable: true });
    expect((await api('/shipping-destination', b.session())).body.destination.country).toBeNull();
  });
});
