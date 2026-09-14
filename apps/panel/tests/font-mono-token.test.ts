import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = [
  'tokens.css', 'base.css', 'components.css', 'shell.css',
  ...['feedback','agenda','conversations','pipeline','auth','post-sales','agenda-calendar','leads'].map((name) => `domains/${name}.css`)
].map((file) => readFileSync(resolve(__dirname, `../styles/${file}`), 'utf8')).join('\n');

describe('font mono token', () => {
  it('uses the replacement token and removes the legacy mono family from CSS', () => {
    expect(css).toMatch(/--font-mono:\s*ui-monospace/);
    expect(css).toContain("monospace");
    expect(css).not.toContain(['IBM', 'Plex', 'Mono'].join(' '));
  });

  it('does not load the legacy mono family from Google Fonts', () => {
    const importLine = css.split('\n')[0];
    expect(importLine).not.toContain('IBM+Plex+Mono');
  });
});
