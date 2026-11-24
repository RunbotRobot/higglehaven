import { describe, it, expect } from 'vitest';
import modeSource from './mode.js?raw';
import worldViewSource from '../sell/worldView.js?raw';

// #4108: Shop and Sell both mount the person's own avatar, and the arrival has to be the same in both
// (#4067: fog until the worn body is known, never the default body first). The hooks are optional
// arguments of mountShopAvatar, so a caller that forgets one compiles and runs, and only shows the
// default body for a moment. This pins that every caller passes all of them.
const HOOKS = ['beginAvatarSwap', 'cancelAvatarSwap', 'beginAvatarFogHold', 'readWornHint', 'writeWornHint'];
const CALLERS = { 'src/shop/mode.js': modeSource, 'src/sell/worldView.js': worldViewSource };

describe('callers of mountShopAvatar', () => {
  for (const [file, source] of Object.entries(CALLERS)) {
    it(`${file} passes every arrival hook and steps the fog each frame`, () => {
      for (const hook of HOOKS) expect(source, hook).toMatch(new RegExp(`\\b${hook}\\b`));
      expect(source).toMatch(/activeAvatarSwap\?\.step\(now\)/);
    });
  }
});
