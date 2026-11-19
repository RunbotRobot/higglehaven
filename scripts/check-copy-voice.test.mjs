import { describe, expect, it } from 'vitest';
import { findVoiceBreaks } from './check-copy-voice.mjs';

// #3888: only the pure part is tested; main() reads the real repo and is run by `pretest`.
const row = (text, area = 'Sell') => ({ file: 'src/sell/x.js', line: 1, kind: 'js', text, area });

describe('findVoiceBreaks', () => {
  it('passes plain sentences and the accented word', () => {
    expect(findVoiceBreaks([row('You don\'t own a lándlet yet. Claim one in Build mode.'), row('Add a product')])).toEqual([]);
  });

  it('flags the retired and internal words people must not read', () => {
    const words = ['Open your landlet', 'Your lánd is ready', 'Tap the bud', 'Open a leaf', 'A petal opens', 'Close this modal'].map((t) => findVoiceBreaks([row(t)])[0]?.word);
    expect(words).toEqual(['landlet', 'lánd', 'bud / flower', 'petal / leaf / stem', 'petal / leaf / stem', 'modal']);
  });

  it('ignores interpolations, console log prefixes, and rows people do not read', () => {
    expect(findVoiceBreaks([row('Claiming ${landlet.name}…')])).toEqual([]);
    expect(findVoiceBreaks([row('bud: ${message}', 'Flower and shared pieces')])).toEqual([]);
    expect(findVoiceBreaks([row('landlet must be a string', 'Server messages')])).toEqual([]);
    expect(findVoiceBreaks([row('landlet', 'Admin pages')])).toEqual([]);
  });
});
