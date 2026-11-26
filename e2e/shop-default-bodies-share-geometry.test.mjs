// #4510: every default avatar body used to build its own nine geometries (780 on the GPU for a crowd of 200, nine buffer
// uploads per arrival). They are built once and shared; releasing one body must free none of them, because the others are
// still drawn with them.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const session = await launchPage({ promptAnswer: 'Shared Body Geometry Tester' });
const { errors, page } = session;
await chooseIdentity(page, { mode: 'shop', label: 'Shared Body Geometry Tester', isNew: true });
await page.waitForFunction(() => typeof window.__testDefaultBodiesShareGeometry === 'function', null, { timeout: 30000 });
const result = await page.evaluate(() => window.__testDefaultBodiesShareGeometry());
console.log('two default bodies:', result);

const pass = result.meshes === 9 && result.sameGeometry === true && result.disposedByRelease === 0 && errors.length === 0;
await finish(session.browser, {
  pass,
  label: '#4510: default bodies share their geometry and releasing one frees none of it',
  errors,
});
