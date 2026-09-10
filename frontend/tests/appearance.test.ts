import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTENT_FONTS, contentTypography, themeClasses } from '../src/store/useSettings.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';

/**
 * The invariant worth guarding: Reading swaps the surface ramp itself (see
 * index.css), while the markup picks its dark colours through `dark:`
 * variants. Both classes at once would darken the warm ramp a second time.
 */
test('dark and reading are never both set', () => {
  for (const theme of ['light', 'dark', 'system', 'reading'] as const) {
    for (const prefersDark of [true, false]) {
      const { dark, reading } = themeClasses(theme, prefersDark);
      assert.equal(dark && reading, false, `${theme} / prefersDark=${prefersDark}`);
    }
  }
});

test('reading wins over the OS preference', () => {
  assert.deepEqual(themeClasses('reading', true), { dark: false, reading: true });
  assert.deepEqual(themeClasses('reading', false), { dark: false, reading: true });
});

test('system follows the OS, explicit choices do not', () => {
  assert.deepEqual(themeClasses('system', true), { dark: true, reading: false });
  assert.deepEqual(themeClasses('system', false), { dark: false, reading: false });
  assert.deepEqual(themeClasses('dark', false), { dark: true, reading: false });
  assert.deepEqual(themeClasses('light', true), { dark: false, reading: false });
});

test('each size step is larger than the last', () => {
  const sizes = (['sm', 'md', 'lg', 'xl'] as const).map(
    (contentSize) => parseFloat(contentTypography({ contentSize, contentFont: 'sans' }).size),
  );
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(sizes[i] > sizes[i - 1], `${sizes[i - 1]} -> ${sizes[i]}`);
  }
});

test('the typeface choice selects a real stack with a fallback', () => {
  assert.match(contentTypography({ contentSize: 'md', contentFont: 'serif' }).font, /serif$/);
  assert.match(contentTypography({ contentSize: 'md', contentFont: 'sans' }).font, /sans-serif$/);
  // Every stack must end in a generic family, or an unavailable face falls
  // back to the browser default rather than to something chosen.
  for (const stack of Object.values(CONTENT_FONTS)) {
    assert.match(stack, /(sans-serif|serif|monospace)$/);
  }
});

test('an unrecognised stored value falls back instead of blanking the text', () => {
  // Settings come from IndexedDB and can predate a change to these unions.
  const rogue = { contentSize: 'huge', contentFont: 'comic' } as unknown as Parameters<
    typeof contentTypography
  >[0];
  const typography = contentTypography(rogue);
  assert.equal(typography.size, contentTypography({ contentSize: 'md', contentFont: 'sans' }).size);
  assert.equal(typography.font, CONTENT_FONTS.sans);
});

test('the defaults are the plain ones', () => {
  assert.equal(DEFAULT_SETTINGS.theme, 'system');
  assert.equal(DEFAULT_SETTINGS.contentFont, 'sans');
  assert.equal(DEFAULT_SETTINGS.contentSize, 'md');
});
