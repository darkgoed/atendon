import { expect, test, type Page } from "@playwright/test";

/**
 * Acceptance for "a agenda escala em dispositivos menores sem ficar cortada
 * nem sobreposta". Every assertion below is a real measurement taken from the
 * rendered page: nothing here passes because a class name exists.
 */

const credentials = {
  email: process.env.PANEL_E2E_EMAIL ?? process.env.PANEL_SEED_EMAIL,
  password: process.env.PANEL_E2E_PASSWORD ?? process.env.PANEL_SEED_PASSWORD
};

const viewports = [
  { name: "320x568", width: 320, height: 568 },
  { name: "360x640", width: 360, height: 640 },
  { name: "390x844", width: 390, height: 844 },
  { name: "414x896", width: 414, height: 896 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 }
] as const;

const modes = ["Dia", "Semana", "Mês"] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(credentials.email!);
  await page.getByLabel("Senha", { exact: true }).fill(credentials.password!);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login", { timeout: 20_000 }),
    page.getByRole("button", { name: "Entrar" }).click()
  ]);
  await suppressVersionBanner(page);
}

/**
 * O modal "O que há de novo" cobre a agenda inteira e intercepta cliques. Ele
 * reabre a cada navegação enquanto o localStorage não registrar exatamente a
 * versão implantada, então gravamos a versão real e reinstalamos o valor em
 * todo document novo.
 */
async function suppressVersionBanner(page: Page) {
  const version = await page.evaluate(async () => {
    const response = await fetch("/backend/panel/version", { credentials: "include" }).catch(() => null);
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    return typeof payload?.version === "string" ? payload.version : null;
  });
  if (!version) throw new Error("Não foi possível ler a versão implantada para suprimir o banner de novidades");
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("atendon_last_seen_version", value as string);
    } catch {
      // localStorage indisponível neste contexto.
    }
  }, version);
  await page.evaluate((value) => {
    try {
      localStorage.setItem("atendon_last_seen_version", value as string);
    } catch {
      // localStorage indisponível neste contexto.
    }
  }, version);
}

type Defect = { kind: string; selector: string; evidence: string };

/**
 * Measures the agenda subtree only. Reports three independent defect classes:
 *  - clipped: a box overflows its own painted area (or leaves the viewport)
 *    and no ancestor up to the agenda root can scroll to reveal it.
 *  - overlap: two leaf text boxes intersect (text on top of text).
 *  - doc-overflow: the document itself scrolls horizontally.
 */
async function measureAgenda(page: Page): Promise<Defect[]> {
  return page.evaluate(() => {
    const defects: { kind: string; selector: string; evidence: string }[] = [];
    const root = document.querySelector(".agenda-head")?.closest(".content") ?? document.body;

    const describe = (el: Element) => {
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
    };

    /**
     * Um elemento visualmente escondido para leitores de tela (.sr-only) é uma
     * caixa de 1px por design: medir corte nele é ruído, não defeito.
     */
    const isScreenReaderOnly = (el: Element) => el.closest(".sr-only") !== null;

    /**
     * Um elemento só está de fato inalcançável quando NENHUM ancestral pode
     * rolar até ele. Um ancestral com overflow:hidden só interrompe a busca se
     * o próprio elemento estourar a caixa desse ancestral — caso contrário ele
     * está inteiro lá dentro e quem precisa ser alcançável é o ancestral.
     */
    const isReachable = (el: Element, axis: "x" | "y") => {
      let current: Element = el;
      for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        const overflow = axis === "x" ? style.overflowX : style.overflowY;
        const scrollSize = axis === "x" ? node.scrollWidth : node.scrollHeight;
        const clientSize = axis === "x" ? node.clientWidth : node.clientHeight;
        if (overflow === "auto" || overflow === "scroll") {
          if (scrollSize > clientSize + 1) return true; // rola e há o que rolar
          // Container rolável que já cabe: o conteúdo interno está resolvido,
          // seguimos avaliando a posição DELE na árvore.
          current = node;
          continue;
        }
        if (overflow === "hidden" || overflow === "clip") {
          const inner = current.getBoundingClientRect();
          const outer = node.getBoundingClientRect();
          const overflowsClip = axis === "x"
            ? inner.right > outer.right + 1 || inner.left < outer.left - 1
            : inner.bottom > outer.bottom + 1 || inner.top < outer.top - 1;
          if (overflowsClip) return false; // recortado sem escapatória
          current = node;
          continue;
        }
        current = node;
      }
      return false;
    };

    const all = [...root.querySelectorAll("*")].filter((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });

    // 1. Self-clipping: the element's own content does not fit its box.
    for (const el of all) {
      if (isScreenReaderOnly(el)) continue;
      const style = getComputedStyle(el);
      const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
      const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
      const ellipsis = style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap";
      if (clipsX && !ellipsis && el.scrollWidth > el.clientWidth + 1) {
        defects.push({ kind: "clipped-x", selector: describe(el), evidence: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` });
      }
      if (clipsY && el.scrollHeight > el.clientHeight + 1) {
        defects.push({ kind: "clipped-y", selector: describe(el), evidence: `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}` });
      }
    }

    // 2. Unreachable overflow: element extends past the viewport with no
    //    scrollable ancestor able to bring it into view.
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    for (const el of all) {
      if (isScreenReaderOnly(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > viewportWidth + 1 && !isReachable(el, "x")) {
        defects.push({ kind: "unreachable-x", selector: describe(el), evidence: `right ${Math.round(rect.right)} > viewport ${viewportWidth}` });
      }
      if (rect.bottom > viewportHeight + 1 && !isReachable(el, "y")) {
        defects.push({ kind: "unreachable-y", selector: describe(el), evidence: `bottom ${Math.round(rect.bottom)} > viewport ${viewportHeight}` });
      }
    }

    // 3. Text-on-text overlap between leaf nodes inside the agenda.
    const leaves = all.filter((el) => !el.children.length && (el.textContent ?? "").trim().length > 0 && !isScreenReaderOnly(el));
    for (let i = 0; i < leaves.length; i += 1) {
      const a = leaves[i].getBoundingClientRect();
      for (let j = i + 1; j < leaves.length; j += 1) {
        const b = leaves[j].getBoundingClientRect();
        if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
          if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
          defects.push({ kind: "overlap", selector: `${describe(leaves[i])} + ${describe(leaves[j])}`, evidence: "intersecting client rects" });
        }
      }
    }

    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      defects.push({
        kind: "doc-overflow",
        selector: "html",
        evidence: `scrollWidth ${document.documentElement.scrollWidth} > clientWidth ${document.documentElement.clientWidth}`
      });
    }

    // Deduplicate: the same structural defect repeated across 40 cells is one
    // finding, not forty.
    const seen = new Set<string>();
    return defects.filter((d) => {
      const key = `${d.kind}|${d.selector}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

test("a agenda escala em telas pequenas sem corte, overflow inalcançável ou sobreposição", async ({ page }) => {
  test.skip(!credentials.email || !credentials.password, "Defina PANEL_E2E_EMAIL/PANEL_E2E_PASSWORD");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);

  const failures: string[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const mode of modes) {
      await page.goto("/agenda", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Agenda", level: 1 })).toBeVisible();
      await page.getByRole("button", { name: mode, exact: true }).click();
      // Aguarda a grade da visualização escolhida antes de medir.
      await page.locator(".agenda-grid, .agenda-month, .agenda-empty").first().waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForTimeout(350);

      const defects = await measureAgenda(page);
      for (const defect of defects) {
        failures.push(`${viewport.name} · ${mode} · ${defect.kind} · ${defect.selector} · ${defect.evidence}`);
      }
    }
  }

  expect(failures, `Defeitos responsivos na agenda:\n${failures.join("\n")}`).toEqual([]);
});

test("a grade da agenda é rolável horizontalmente em telas estreitas", async ({ page }) => {
  test.skip(!credentials.email || !credentials.password, "Defina PANEL_E2E_EMAIL/PANEL_E2E_PASSWORD");
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/agenda", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Semana", exact: true }).click();
  await page.locator(".agenda-grid, .agenda-empty").first().waitFor({ state: "visible", timeout: 15_000 });

  const scroller = page.locator(".agenda-scroll");
  const metrics = await scroller.evaluate((el) => ({
    overflowX: getComputedStyle(el).overflowX,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth
  }));
  expect(["auto", "scroll"], `.agenda-scroll precisa rolar no eixo X, veio "${metrics.overflowX}"`).toContain(metrics.overflowX);

  if (metrics.scrollWidth > metrics.clientWidth + 1) {
    // Se há conteúdo além da borda, ele precisa ser alcançável de fato.
    const reached = await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      return el.scrollLeft;
    });
    expect(reached, "a grade não rolou até a última coluna").toBeGreaterThan(0);
  }
});
