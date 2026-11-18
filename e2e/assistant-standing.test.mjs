// #3636 part 2: the assistant window says where she is standing while she is on shift and
// out of sight, with "Take me there" (the same fade and landing as Go to Last Location), and
// says nothing when she is off shift or right here. Setup is assistant-chat-panel's: A is an
// ordinary shopper in the Shop world; B is made an assistant account directly in the local D1
// (fleet-login needs a deployment secret) and kept on shift by an inbox poll's timestamp.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, finish } from './helpers.mjs';

const LABEL_A = 'Standing Shopper';
const LABEL_B = 'Standing Stand-in';

const sessionA = await launchPage({ promptAnswer: LABEL_A, viewport: { width: 390, height: 800 } });
const sessionB = await launchPage({ promptAnswer: LABEL_B, viewport: { width: 390, height: 800 } });
const pageA = sessionA.page;
const pageB = sessionB.page;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}
const sql = (statement) => execSync(`npx wrangler d1 execute higglehaven-db --local --command "${statement}"`, {
  cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
});
const quote = (value) => value.replace(/'/g, "''");

// A public landlet for her to stand on.
await createGreenbeltLandletAsAdmin('standing-greenbelt');

await chooseIdentity(pageA, { mode: 'shop', label: LABEL_A, isNew: true });
await pageA.waitForSelector('body.shop-ready', { timeout: 20000 });
await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });

const userB = (await fetchJson(pageB, '/api/auth/me')).body.user;
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
sql(`UPDATE users SET is_fleet = 1, username = 'Juniper' WHERE username = '${quote(userB.username)}'`);
const stamp = (iso) => sql(`UPDATE users SET assistant_seen_at = ${iso ? `'${iso}'` : 'NULL'} WHERE user_id = '${quote(userB.userId)}'`);
const target = { userId: userB.userId, builderId: builderB.builderId, name: 'Juniper' };
const panelState = () => pageA.evaluate(() => ({
  line: document.getElementById('assistant-chat-standing-text').textContent,
  shown: !document.getElementById('assistant-chat-standing').hidden,
  minimized: window.__assistantChat.minimized,
  open: window.__assistantChat.open,
}));
const closePanel = async () => {
  await pageA.evaluate(() => document.getElementById('assistant-chat-close').click());
  await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });
};

// Off shift: no line.
stamp(null);
await pageA.evaluate((t) => window.__testOpenAssistant(t), target);
await pageA.waitForTimeout(1500);
let state = await panelState();
check(!state.shown && state.line === '', `off shift, the window says nothing about where she stands (${JSON.stringify(state)})`);
await closePanel();

// On shift: the server's spot, and the line.
stamp(new Date().toISOString());
const standingList = (await fetchJson(pageA, '/api/assistant/standing')).body.assistants;
const spot = standingList.find((a) => a.userId === userB.userId);
check(Boolean(spot) && spot.name === 'Juniper', `the server lists her on shift (${JSON.stringify(spot)})`);

// Far away: the line and the walk. (The avatar drops in at spawn first; a teleport during the
// drop is overwritten, so wait for it to land.)
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.evaluate(() => window.__testToggleShopFlight()); // #3650: the fly button is gone
await pageA.waitForTimeout(2500);
await pageA.evaluate(([x, y]) => window.__testTeleportShopAvatar(x + 60, y, 0), [spot.x, spot.y]);
await pageA.waitForTimeout(500);
await pageA.evaluate((t) => window.__testOpenAssistant(t), target);
await pageA.waitForFunction(() => document.getElementById('assistant-chat-standing-text').textContent !== '', null, { timeout: 10000 });
state = await panelState();
if (false) console.log('DEBUG', JSON.stringify({ spot, pos: await pageA.evaluate(() => window.__testShopAvatarPosition()), mode: await pageA.evaluate(() => document.body.dataset.mode) }));
check(state.shown && state.line === `Juniper is standing on lándlet ${spot.landletId}.`, `far from her, the window says where she stands (${JSON.stringify(state)})`);

// Take me there: the window tucks away, and the avatar ends up at her spot.
await pageA.click('#assistant-chat-go');
state = await panelState();
check(state.minimized && state.open, `the walk tucks the window away and keeps it open (${JSON.stringify(state)})`);
await pageA.waitForFunction(([x, y]) => {
  const p = window.__testShopAvatarPosition();
  return Math.hypot(p.x - x, p.y - y) < 10;
}, [spot.x, spot.y], { timeout: 30000 });
const arrived = await pageA.evaluate(() => window.__testShopAvatarPosition());
check(Math.hypot(arrived.x - spot.x, arrived.y - spot.y) < 10, `the avatar was taken to her spot (${JSON.stringify(arrived)} vs ${spot.x}, ${spot.y})`);

// Right here: no walk is offered.
await pageA.evaluate(() => document.getElementById('account-menu-toggle').click());
await pageA.evaluate(() => document.getElementById('assistant-menu-btn').click());
await pageA.waitForSelector('#assistant-chat-panel:not(.minimized)', { timeout: 5000 });
await pageA.evaluate(() => document.getElementById('assistant-chat-close').click());
await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });
await pageA.evaluate((t) => window.__testOpenAssistant(t), target);
await pageA.waitForTimeout(2000);
state = await panelState();
check(!state.shown, `standing next to her, no walk is offered (${JSON.stringify(state)})`);

await finish(sessionA.browser, { pass, label: '#3636: the assistant window says where she stands and offers to walk there', errors: sessionA.errors });
