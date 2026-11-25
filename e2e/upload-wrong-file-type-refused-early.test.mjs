// #4345: a file that is not a .glb or .fbx is refused on the file step, in plain words, before anything is
// converted or uploaded. (The 20MB limit is checked after the browser has reduced the model; both read
// shared/model-limits.js.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchPage, chooseIdentity, finish, openAddProductLeaf } from './helpers.mjs';

const LABEL = 'Wrong Type Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-wrong-type-'));
const txt = path.join(dir, 'notes.txt');
fs.writeFileSync(txt, 'not a model');

let uploadRequests = 0;
page.on('request', (r) => { if (r.method() === 'POST' && /\/models/.test(r.url())) uploadRequests += 1; });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'Wrong Type Thing');
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', txt);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => /\.glb and \.fbx/.test(document.getElementById('upload-status').textContent), null, { timeout: 10000 });

const status = await page.textContent('#upload-status');
const isError = await page.locator('#upload-status.error').count();
const stillOnFileStep = await page.evaluate(() => !document.getElementById('upload-step-file').hidden);
console.log('status:', status);
console.log('shown as an error (should be 1):', isError);
console.log('still on the file step (should be true):', stillOnFileStep);
console.log('upload requests (should be 0):', uploadRequests);

fs.rmSync(dir, { recursive: true, force: true });
const pass = isError === 1 && stillOnFileStep && uploadRequests === 0;
await finish(browser, {
  pass,
  label: 'A file that is not .glb or .fbx is refused on the file step, before any upload (#4345)',
  errors,
});
