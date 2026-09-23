import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStyleSources } from './style-sources';

const css = readStyleSources();

describe('font mono token', () => {
  it('uses the replacement token and removes the legacy mono family from CSS', () => {
    // Intenção: existe UM token mono do sistema e ele não carrega a família legada.
    // A lista exata de fallbacks é detalhe de implementação, então asseguramos a
    // forma (Geist Mono opcional do DS v2, depois ui-monospace, termina em
    // monospace) em vez da string literal.
    expect(css).toMatch(/--font-mono:\s*(?:"Geist Mono",\s*)?ui-monospace,[^;]*monospace;/);
    expect(css).not.toContain(['IBM', 'Plex', 'Mono'].join(' '));
  });

  it('does not load the legacy mono family from Google Fonts', () => {
    // O @import de fontes vive em app/globals.css, não nos stylesheets de styles/:
    // a versão anterior deste teste lia a primeira linha da concatenação de
    // styles/ e passava vaziamente. Agora olha o arquivo certo.
    const globals = readFileSync(resolve(__dirname, '../app/globals.css'), 'utf8');
    expect(globals).not.toContain('IBM+Plex+Mono');
  });
});
