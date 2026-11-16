// #3541: the design census counts distinct values the same however they are
// written. (The token/DESIGN.md agreement is scripts/check-design-tokens.mjs,
// run from pretest, because vitest stubs CSS imports.)
const tokensCss = ':root { --ink-rgb: 22 36 10; --ink: rgb(var(--ink-rgb)); --text-sm: 13px; --space-sm: 8px; --space-lg: 12px; --radius-md: 8px; }';
import { describe, it, expect } from 'vitest';
import { census, resolveTokens } from './design-census.mjs';

describe('design census', () => {
  it('counts distinct values the same before and after a value moves onto a token', () => {
    const literal = '.a { font-size: 13px; padding: 8px 12px; border-radius: 8px; }';
    const tokened = '.a { font-size: var(--text-sm); padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-md); }';
    const before = census(literal, tokensCss);
    const after = census(tokened, tokensCss);
    expect(after.inUse).toEqual(before.inUse);
    expect(after.distinct.fontSizes).toBe(0);
    expect(before.distinct.fontSizes).toBe(1);
    expect(after.onTokens.fontSizes).toBe(1);
  });

  it('treats the same colour at different opacities as one hue', () => {
    const r = census('.a { color: rgb(22 36 10 / 0.25); } .b { color: rgb(22 36 10 / 0.65); }');
    expect(r.distinct.colors).toBe(2);
    expect(r.distinct.hues).toBe(1);
  });

  it('resolves nested tokens', () => {
    expect(resolveTokens('.a { color: var(--ink); }', tokensCss)).toContain('rgb(22 36 10)');
  });
});
