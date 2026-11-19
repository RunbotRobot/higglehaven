import { describe, expect, it } from 'vitest';
import { findCaseBreaks, findVoiceBreaks, findWorkerVoiceBreaks } from './check-copy-voice.mjs';

// #3888: only the pure part is tested; main() reads the real repo and is run by `pretest`.
const row = (text, area = 'Sell') => ({ file: 'src/sell/x.js', line: 1, kind: 'js', text, area });

describe('findVoiceBreaks', () => {
  it('passes plain sentences and the accented word', () => {
    expect(findVoiceBreaks([row('You don\'t own a lándlet yet. Claim one in Build mode.'), row('Add a product')])).toEqual([]);
  });

  it('flags the retired and internal words people must not read', () => {
    const words = ['Open your landlet', 'Your lánd is ready', 'Tap the bud', 'Open a leaf', 'A petal opens', 'Close this modal', 'Please try again'].map((t) => findVoiceBreaks([row(t)])[0]?.word);
    expect(words).toEqual(['landlet', 'lánd', 'bud / flower', 'petal / leaf / stem', 'petal / leaf / stem', 'modal', 'please']);
  });

  it('ignores interpolations, console log prefixes, and rows people do not read', () => {
    expect(findVoiceBreaks([row('Claiming ${landlet.name}…')])).toEqual([]);
    expect(findVoiceBreaks([row('bud: ${message}', 'Flower and shared pieces')])).toEqual([]);
    expect(findVoiceBreaks([row('landlet must be a string', 'Server messages')])).toEqual([]);
    expect(findVoiceBreaks([row('landlet', 'Admin pages')])).toEqual([]);
  });
});

describe('findWorkerVoiceBreaks', () => {
  const src = (source) => [{ file: 'worker/x.js', source }];
  it('flags plain landlet in a refusal a person reads', () => {
    expect(findWorkerVoiceBreaks(src("throw new HttpError(404, 'Landlet not found');"))[0]).toMatchObject({ line: 1, word: 'landlet' });
    expect(findWorkerVoiceBreaks(src('return json({ error: `No such landlet` }, 404);'))).toHaveLength(1);
  });
  it('passes the accented word, interpolations and names that are not sentences', () => {
    expect(findWorkerVoiceBreaks(src("throw new HttpError(404, 'Lándlet not found');"))).toEqual([]);
    expect(findWorkerVoiceBreaks(src("throw new HttpError(400, `Bad ${landlet} id`);"))).toEqual([]);
    expect(findWorkerVoiceBreaks(src("const landlet_id = 'landlet'; console.error('landlet failed');"))).toEqual([]);
  });
});

describe('findCaseBreaks', () => {
  it('passes sentence case, the three places, acronyms and sentences', () => {
    const ok = ['Add a product', 'My purchases', 'Log in / Sign up', 'Go to Shop', 'Switch to Build mode', 'Upload a PNG or GLB', 'Edit price ▾', 'View bids (${n})', 'Lándlet cap', 'Tap a product in Shop mode to buy it. Your Orders will be listed here.'];
    expect(findCaseBreaks(ok.map((t) => row(t)))).toEqual([]);
  });

  it('flags Title Case labels and says which word', () => {
    const found = ['Add A Product', 'Go to Last Location', 'Edit Digital Good ▾', 'Save Sit/Lean Target', 'Sell Your Lándlet'].map((t) => findCaseBreaks([row(t)])[0]);
    expect(found.map((b) => b.word)).toEqual(Array(5).fill('letter case'));
    expect(found[1].why).toContain('"Last", "Location"');
    expect(found[3].why).toContain('"Sit"');
  });

  it('does not check one-word labels, sentences with stops, interpolations or rows people do not read', () => {
    expect(findCaseBreaks([row('Notices'), row('Close'), row('Claiming ${Landlet.Name}')])).toEqual([]);
    expect(findCaseBreaks([row('Generated! Optimizing…'), row('Card confirmed. Recording Your Order…')])).toEqual([]);
    expect(findCaseBreaks([row('Go To Last Location', 'Admin pages'), row('Go To Last Location', 'Server messages')])).toEqual([]);
  });

  it('lets an allowed label through', () => {
    expect(findCaseBreaks([row('e.g. Brick')])).toEqual([]);
  });
});
