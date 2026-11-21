// #3819: with a mouse (1280x800), everything the head offers shows it can be clicked: the pointer
// cursor on the head, the petals and the leaf rows. Before, every one of them kept the arrow, so
// nothing said "this is a button". The hover dimming applies only to a pointer that can hover.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Pointer Tester', viewport: { width: 1280, height: 800 } });
await chooseIdentity(page, { mode: 'shop', label: 'Pointer Tester', isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });

const cursorOf = (selector) => page.evaluate((s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).cursor : null; }, selector);
const cursors = { head: await cursorOf('#account-menu-toggle') };
await page.click('#account-menu-toggle');
await page.waitForTimeout(700);
cursors.petalBuild = await cursorOf('#bud-modes .mode-nav-btn[data-mode="build"]');
cursors.settings = await cursorOf('#settings-btn');
await page.click('#bud-petal-row-help');
await page.waitForSelector('.help-row', { timeout: 5000 });
cursors.helpRow = await cursorOf('.help-row');
cursors.leafClose = await cursorOf('.bud-leaf-close');
console.log('cursors:', JSON.stringify(cursors));

const pass = Object.values(cursors).every((c) => c === 'pointer');
await finish(browser, { pass, label: '#3819: the head, petals and leaf rows show a pointer under a mouse', errors });
