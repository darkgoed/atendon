import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStyleSources } from './style-sources';

const css = readStyleSources();

describe('font sans token', () => {
  it('uses Geist as the only sans webfont with a system fallback', () => {
    // Intenção: a família proporcional do produto é Geist (carregada via Google
    // Fonts) e a pilha termina em fallbacks de sistema — nenhuma outra família
    // nomeada no token.
    expect(css).toMatch(/--font-sans:\s*"Geist",\s*ui-sans-serif,[^;]*sans-serif;/);
    expect(css).not.toContain('"Inter"');
    expect(css).not.toContain('Manrope');
  });

  it('loads Geist from Google Fonts and not Inter', () => {
    // O @import de fontes vive em app/globals.css, não nos stylesheets de styles/.
    const globals = readFileSync(resolve(__dirname, '../app/globals.css'), 'utf8');
    expect(globals).toMatch(/family=Geist:wght@400\.\.700/);
    expect(globals).not.toContain('family=Inter');
  });
});
