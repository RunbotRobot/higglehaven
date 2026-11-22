// #3930 (part of #3539): scripts/seed-local-world.mjs keeps working and keeps being idempotent.
// A seed nobody runs rots (scripts/seed-mockup-data.mjs stopped working when a digital good began to
// need a model), so this runs it twice against the test server and reads back what it promised:
// looker owns a lándlet with a dozen items, a bundle, a published version, three products (one sold
// out), an order not yet rated and a notice, an owned avatar, ID-verified accounts and an assistant
// thread with one question and its answer (#4043); neighbor's friend request is waiting; the second run
// changes nothing and says nothing was added.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.E2E_PORT || '8787';
const base = `http://127.0.0.1:${port}`;
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

function runSeed() {
  const result = spawnSync('node', ['scripts/seed-local-world.mjs', '--url', base], { cwd: root, encoding: 'utf8', timeout: 120000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const first = runSeed();
console.log(first.out);
check(first.status === 0, 'the first run succeeds');

const second = runSeed();
console.log(second.out);
check(second.status === 0, 'the second run succeeds');
const added = second.out.split('\n').filter((line) => /listed|Placed|claimed|saved the bundle|Published|bought|resized|friend request|ID-verified|answered|avatar/.test(line));
check(added.length === 0, `the second run adds nothing (${added.join(' | ') || 'nothing added'})`);

async function signIn(name) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@e2e.test`, password: 'live-site-local-password-123' }),
  });
  return response.headers.get('set-cookie')?.match(/hh_session=([^;]+)/)?.[0] ?? null;
}
async function get(route, cookie) {
  const response = await fetch(`${base}/api${route}`, { headers: { cookie } });
  return response.json();
}

const looker = await signIn('looker');
check(Boolean(looker), 'looker can sign in with the live-site local login');
const { builder } = await get('/builders/me', looker);
const { landlets } = await get(`/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=5`, looker);
check(landlets.length === 1, 'looker owns exactly one lándlet');
const { instances } = await get(`/instances?landletId=${landlets[0]?.landletId}`, looker);
check((instances ?? []).length === 12, `twelve items are placed (${(instances ?? []).length})`);
const { bundles } = await get('/bundles', looker);
check((bundles ?? []).filter((b) => b.name === 'Reading Corner').length === 1, 'one bundle named Reading Corner');
const { versions } = await get(`/landlets/${landlets[0]?.landletId}/versions`, looker);
check((versions ?? []).length === 1, 'one published version');
const { seller } = await get('/sellers/me', looker);
const { templates } = await get(`/catalog?sellerId=${seller.sellerId}&limit=100`, looker);
check((templates ?? []).length === 3, 'looker sells three products');
check((templates ?? []).filter((t) => t.stockQuantity === 0).length === 1, 'exactly one of them is sold out');
const { purchases } = await get('/purchases/mine', looker);
check((purchases ?? []).length === 2, `looker has two orders (${(purchases ?? []).length}): a planter and an avatar`);
const { avatars } = await get('/builders/me/avatars', looker);
check((avatars ?? []).some((a) => /Moss Walker/.test(JSON.stringify(a))), 'looker owns the avatar Moss Walker');
const thread = await get('/assistant-chat/question', looker);
check(!thread.error, `looker is ID-verified: the assistant route answers (${thread.error ?? 'ok'})`);
const state = await get('/assistant-chat/current', looker);
check((state.history ?? []).some((m) => m.sender === 'assistant') && (state.history ?? []).some((m) => m.sender === 'shopper'), 'the assistant thread holds a question and its answer');
const { notifications } = await get('/notifications', looker);
check((notifications ?? []).length >= 2, 'looker has a notice and a friend request notice');
const { friendships } = await get('/friendships', looker);
check((friendships ?? []).length === 1 && friendships[0].status === 'pending', 'one friend request is waiting');

console.log(failures.length ? `FAIL: seed-local-world (${failures.length} failed)` : 'PASS: seed-local-world');
process.exit(failures.length ? 1 : 0);
