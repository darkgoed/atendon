// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearElement,
  copyTextToClipboard,
  deepClone,
  randomUUID,
  shouldSubmitOnEnter,
  submitForm
} from "@/lib/compat";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function attach(element: HTMLElement): { remove(): void } {
  document.body.appendChild(element);
  return { remove: () => element.remove() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldSubmitOnEnter (Enter, Shift+Enter e IME)", () => {
  it("envia apenas no Enter sem Shift e fora de composição", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true);
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "a", shiftKey: false, isComposing: false, keyCode: 65 })).toBe(false);
  });

  it("bloqueia o Enter durante a composição do IME (Chrome/Firefox)", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, compositionActive: true, keyCode: 13 })).toBe(false);
  });

  it("bloqueia o Enter que confirma a composição na ordem do Safari (compositionend antes do keydown)", () => {
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      compositionJustEnded: true
    })).toBe(false);
  });

  it("bloquea keydowns marcados como Process (keyCode 229)", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });
});

describe("submitForm (requestSubmit e fallback para Safari < 16)", () => {
  it("usa requestSubmit quando o navegador tem", () => {
    const form = document.createElement("form");
    const requestSubmit = vi.fn();
    Object.defineProperty(form, "requestSubmit", { configurable: true, value: requestSubmit });
    expect(submitForm(form)).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("retorna false sem formulário", () => {
    expect(submitForm(null)).toBe(false);
  });

  it("fallback: aciona o botão de submit habilitado pelo fluxo nativo", () => {
    const form = document.createElement("form");
    Object.defineProperty(form, "requestSubmit", { configurable: true, value: undefined });
    const button = document.createElement("button");
    button.type = "submit";
    const click = vi.fn();
    Object.defineProperty(button, "click", { configurable: true, value: click });
    form.appendChild(button);
    const mounted = attach(form);
    expect(submitForm(form)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    mounted.remove();
  });

  it("fallback: sem botão habilitado, despacha o evento submit", () => {
    const form = document.createElement("form");
    Object.defineProperty(form, "requestSubmit", { configurable: true, value: undefined });
    const button = document.createElement("button");
    button.type = "submit";
    button.disabled = true;
    form.appendChild(button);
    const listener = vi.fn();
    form.addEventListener("submit", listener);
    const mounted = attach(form);
    expect(submitForm(form)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    mounted.remove();
  });

  it("fallback: formulário inválido não despacha submit (mesma validação do requestSubmit)", () => {
    const form = document.createElement("form");
    Object.defineProperty(form, "requestSubmit", { configurable: true, value: undefined });
    const input = document.createElement("input");
    input.required = true;
    form.appendChild(input);
    const listener = vi.fn();
    form.addEventListener("submit", listener);
    const mounted = attach(form);
    expect(submitForm(form)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    mounted.remove();
  });
});

describe("randomUUID com fallback", () => {
  it("gera UUID v4 no caminho nativo e no fallback (Safari < 15.4)", () => {
    expect(randomUUID()).toMatch(UUID_V4);
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      expect(randomUUID()).toMatch(UUID_V4);
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: original });
    }
    expect(randomUUID()).toMatch(UUID_V4);
  });
});

describe("deepClone com fallback", () => {
  it("copia estruturas aninhadas sem compartilhar referências", () => {
    const value = { a: 1, b: ["x", "y"], c: { d: 2 } };
    const copy = deepClone(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(copy.b).not.toBe(value.b);
    expect(copy.c).not.toBe(value.c);
  });
});

describe("copyTextToClipboard com fallback", () => {
  it("usa navigator.clipboard quando disponível", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard")
      ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      await expect(copyTextToClipboard("mensagem")).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith("mensagem");
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("cai para o caminho legado sem quebrar quando nada está disponível", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard")
      ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      await expect(copyTextToClipboard("mensagem")).resolves.toBe(false);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });
});

describe("clearElement (replaceChildren e fallback)", () => {
  it("esvazia o elemento e tolera nulo", () => {
    const parent = document.createElement("div");
    parent.innerHTML = "<span>1</span><span>2</span>";
    clearElement(parent);
    expect(parent.childNodes).toHaveLength(0);
    expect(() => clearElement(null)).not.toThrow();
  });
});

describe("polyfills executados ao importar o módulo", () => {
  it("repõe Array.prototype.at ausente (Safari 14 e anteriores)", async () => {
    const native = Array.prototype.at;
    delete (Array.prototype as unknown as { at?: unknown }).at;
    try {
      vi.resetModules();
      await import("@/lib/compat");
      expect([3, 9].at(-1)).toBe(9);
      expect(["a", "b"].at(-5)).toBeUndefined();
    } finally {
      Array.prototype.at = native as NonNullable<typeof native>;
      vi.resetModules();
    }
  });

  it("repõe String.prototype.replaceAll ausente (Safari 13.0)", async () => {
    const native = String.prototype.replaceAll;
    delete (String.prototype as unknown as { replaceAll?: unknown }).replaceAll;
    try {
      vi.resetModules();
      await import("@/lib/compat");
      expect("a-b-c".replaceAll("-", "+")).toBe("a+b+c");
      expect("x_y".replaceAll("_", " ")).toBe("x y");
      expect(() => "abc".replaceAll(/-/, "+")).toThrow(TypeError);
    } finally {
      String.prototype.replaceAll = native as NonNullable<typeof native>;
      vi.resetModules();
    }
  });

  it("repõe Promise.allSettled ausente (Safari 12.x)", async () => {
    const native = Promise.allSettled;
    delete (Promise as unknown as { allSettled?: unknown }).allSettled;
    try {
      vi.resetModules();
      await import("@/lib/compat");
      const results = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("boom"))]);
      expect(results[0]).toMatchObject({ status: "fulfilled", value: 1 });
      expect(results[1]).toMatchObject({ status: "rejected" });
    } finally {
      Promise.allSettled = native as NonNullable<typeof native>;
      vi.resetModules();
    }
  });
});
