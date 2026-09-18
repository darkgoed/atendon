// Compatibilidade de navegadores antigos (foco: Safari 12–15 em macOS antigos;
// também Chrome < 108, Firefox < 101 e Edge Legacy). O Next transpila a SINTAXE
// para Safari 12, mas não aplica polyfills de APIs — o projeto concentrava
// chamadas como `form.requestSubmit()` e `crypto.randomUUID()` que derrubam o
// fluxo de envio (`a.requestSubmit is not a function`) em navegadores antigos.
//
// Regras deste módulo:
// 1. Todo acesso a API nova passa por feature detection; nenhum acesso "nu".
// 2. Os fallbacks preservam o comportamento nativo (validação, eventos de
//    submit, teclado e IME), nunca apenas silenciam o erro.
// 3. Os polyfills executam uma vez, no import do layout raiz, antes do resto.

/* ------------------------------------------------------------------ */
/* Polyfills (Safari 12–15)                                            */
/* ------------------------------------------------------------------ */

if (typeof Array.prototype.at !== "function") {
  Object.defineProperty(Array.prototype, "at", {
    value: function at(this: ArrayLike<unknown>, index: number) {
      const length = this.length >>> 0;
      const relative = Math.trunc(index) || 0;
      const position = relative >= 0 ? relative : length + relative;
      return position >= 0 && position < length ? this[position] : undefined;
    },
    writable: true,
    configurable: true
  });
}

if (typeof String.prototype.replaceAll !== "function") {
  Object.defineProperty(String.prototype, "replaceAll", {
    value: function replaceAll(this: string, searchValue: string | RegExp, replaceValue: string) {
      const subject = String(this);
      if (searchValue instanceof RegExp) {
        // Comportamento idêntico ao nativo: regex sem a flag global é erro.
        if (!searchValue.global) throw new TypeError("String.prototype.replaceAll exige regex com a flag global");
        return subject.replace(searchValue, replaceValue);
      }
      return subject.split(searchValue).join(replaceValue);
    },
    writable: true,
    configurable: true
  });
}

if (typeof Promise.allSettled !== "function") {
  Object.defineProperty(Promise, "allSettled", {
    value: function allSettled<T>(values: Iterable<T | PromiseLike<T>>): Promise<Array<PromiseSettledResult<T>>> {
      return Promise.all(
        Array.from(values, (value) =>
          Promise.resolve(value).then(
            (result): PromiseSettledResult<T> => ({ status: "fulfilled", value: result }),
            (reason): PromiseSettledResult<T> => ({ status: "rejected", reason })
          )
        )
      );
    },
    writable: true,
    configurable: true
  });
}

/* ------------------------------------------------------------------ */
/* Formulários e teclado                                               */
/* ------------------------------------------------------------------ */

/**
 * Envia o formulário pelo fluxo nativo do navegador, com fallback para
 * navegadores sem `HTMLFormElement.requestSubmit` (Safari < 16 — o bug
 * "a.requestSubmit is not a function" em MacBooks antigos).
 *
 * - Navegadores modernos: `requestSubmit()` roda validação e o fluxo completo
 *   de submissão, como se o botão padrão tivesse sido acionado.
 * - Fallback: validação via `checkValidity`, depois clique programático no
 *   botão de submit habilitado (mesmo fluxo nativo) ou, na ausência de botão
 *   habilitado, despacho do evento `submit` para os handlers do framework.
 *   Retorna `false` quando a submissão não partiu (ex.: formulário inválido).
 */
export function submitForm(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return true;
  }
  if (typeof form.checkValidity === "function" && !form.checkValidity()) {
    form.reportValidity?.();
    return false;
  }
  const submitter = form.querySelector<HTMLButtonElement | HTMLInputElement>(
    'button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])'
  );
  if (submitter) {
    submitter.click();
    return true;
  }
  const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
  return form.dispatchEvent(submitEvent);
}

/**
 * Decide se o Enter atual deve enviar, preservando Shift+Enter como quebra de
 * linha e respeitando IME/composition:
 * - `isComposing`: Chrome/Firefox marcam o keydown durante a composição.
 * - `compositionActive`/`compositionJustEnded`: o Safari dispara
 *   `compositionend` ANTES do keydown que confirma a composição, então
 *   `isComposing` já é `false` nesse Enter — sem o rastro dos eventos de
 *   composição, o texto intermediário seria enviado.
 * - `keyCode 229` ("Process"): navegadores/IMEs que não identificam a tecla.
 */
export function shouldSubmitOnEnter(input: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  compositionActive?: boolean;
  compositionJustEnded?: boolean;
}): boolean {
  if (input.key !== "Enter" || input.shiftKey) return false;
  if (input.isComposing || input.compositionActive || input.compositionJustEnded) return false;
  return input.keyCode !== 229;
}

/* ------------------------------------------------------------------ */
/* Identificadores e utilidades                                        */
/* ------------------------------------------------------------------ */

/**
 * UUID v4 com feature detection: `crypto.randomUUID` só existe em Safari 15.4+
 * (e exige contexto seguro). Fallback: bytes de `crypto.getRandomValues`
 * (Safari 6+) moldados em UUID v4; último recurso, aleatoriedade comum.
 */
export function randomUUID(): string {
  const source = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * Cópia profunda com fallback para Safari < 15.4. O único uso no painel é sobre
 * valores JSON (configurações de humanização), então o round-trip JSON é fiel.
 */
export function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Copia texto com fallback legado (`execCommand`) para navegadores sem
 * `navigator.clipboard` (Safari < 13.1) e para falhas de permissão.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permissão negada/contexto não seguro: tenta o caminho legado abaixo.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Esvazia um elemento com fallback para `replaceChildren` (Safari < 14,
 * Chrome < 86) — usado na limpeza do iframe do Meet.
 */
export function clearElement(element: Element | null | undefined): void {
  if (!element) return;
  if (typeof element.replaceChildren === "function") {
    element.replaceChildren();
    return;
  }
  while (element.firstChild) element.removeChild(element.firstChild);
}

/**
 * `AudioContext` com fallback ao prefixo `webkitAudioContext` (Safari < 14.1).
 * Retorna `null` quando a Web Audio API não está disponível.
 */
export function createAudioContext(): AudioContext | null {
  const modern = typeof AudioContext === "function" ? AudioContext : undefined;
  const legacy = (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const Ctor = modern ?? legacy;
  return typeof Ctor === "function" ? new Ctor() : null;
}

/**
 * `localStorage` com feature detection: acesso "nu" derruba navegadores antigos
 * em modo privado (Safari < 11 lança ao tocar em `localStorage`) e páginas
 * com storage bloqueado (cookies desativados). Retorna `null` quando o
 * storage não está disponível; o chamador degrada com elegância.
 */
export function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined" || localStorage === null) return null;
    const probe = "__atendon-storage-probe__";
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * `decodeAudioData` na forma com callbacks: Safari < 14.1 não cumpre a
 * forma de Promise (resolvia `undefined` e a waveform ficava vazia). Em
 * navegadores modernos a Promise retornada e os callbacks coexistem — o
 * primeiro `resolve` vence e o segundo é ignorado.
 */
export function decodeAudioDataCompat(context: AudioContext, buffer: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const result = context.decodeAudioData(buffer, resolve, reject) as unknown as Promise<AudioBuffer> | undefined;
      if (result && typeof result.then === "function") result.then(resolve, reject);
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
}
