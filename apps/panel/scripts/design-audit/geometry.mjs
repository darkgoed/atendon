/**
 * Pure geometry classifier used by the browser audit and unit tests.
 *
 * An overflow ancestor only clips on the axis where it has no usable scroll
 * room.  This deliberately models the browser's current scroll position: a
 * control below an auto scroller's fold is reachable, while content beyond a
 * hidden/clip edge is not.
 */
const EPSILON = 1;
const outside = (control, box) => ({
  x: control.left < box.left - EPSILON || control.right > box.right + EPSILON,
  y: control.top < box.top - EPSILON || control.bottom > box.bottom + EPSILON,
});

function axisState(ancestor, axis) {
  const overflow = ancestor[`overflow${axis.toUpperCase()}`] ?? (ancestor.overflow ? "hidden" : "visible");
  const client = ancestor[axis === "x" ? "clientWidth" : "clientHeight"];
  const scroll = ancestor[axis === "x" ? "scrollWidth" : "scrollHeight"];
  const scrollable = (overflow === "auto" || overflow === "scroll") && Number.isFinite(scroll) && Number.isFinite(client) && scroll > client + EPSILON;
  const room = scrollable ? Math.max(0, scroll - client) : 0;
  const current = ancestor[axis === "x" ? "scrollLeft" : "scrollTop"] ?? 0;
  return { overflow, scrollable, room, current };
}

function canReachOnAxis(control, ancestor, axis) {
  const state = axisState(ancestor, axis);
  const edge = outside(control, ancestor)[axis];
  if (!edge) return true;
  if (state.scrollable) {
    const start = axis === "x" ? control.left - ancestor.left + state.current : control.top - ancestor.top + state.current;
    const size = axis === "x" ? control.right - control.left : control.bottom - control.top;
    return start >= -EPSILON && start + size <= (axis === "x" ? ancestor.clientWidth : ancestor.clientHeight) + state.room + EPSILON;
  }
  return state.overflow !== "hidden" && state.overflow !== "clip";
}

// Contêiner visualmente oculto de propósito (.sr-only; thead de tabela responsiva em ≤900px): caixa
// de no máximo 1px fora do fluxo, overflow cortado e clip zerado. Controle DENTRO dele é conteúdo
// só para tecnologia assistiva, não um botão visível cortado. A assinatura exige todos os sinais:
// contêiner que colapsou sem clip zerado (bug de layout) ou em fluxo normal continua reprovando.
const ZERO_CLIP = /^rect\(\s*0(?:px)?\s*[, ]\s*0(?:px)?\s*[, ]\s*0(?:px)?\s*[, ]\s*0(?:px)?\s*\)$/;
const clipsAll = (overflow) => overflow === "hidden" || overflow === "clip";
const isVisuallyHidden = (ancestor) =>
  (ancestor.position === "absolute" || ancestor.position === "fixed")
  && ancestor.right - ancestor.left <= 1 + EPSILON && ancestor.bottom - ancestor.top <= 1 + EPSILON
  && clipsAll(ancestor.overflowX) && clipsAll(ancestor.overflowY)
  && ZERO_CLIP.test(String(ancestor.clip ?? "").trim());

// Controle position:fixed só é oculto de verdade quando um containing block (transform/perspective/filter) o prende dentro
// de um contêiner oculto. ancestors vem do mais próximo ao mais distante: basta o contêiner oculto mais distante estar no
// containing block ou acima dele. Sem containing block o fixed não é excluído e segue no gate normal (no Chromium o clip
// zerado também esconde o fixed solto, e o gate o reprova). ponytail: só ancestrais com overflow são coletados; transform
// sem overflow não conta como containing block, o que erra para reprovar e nunca para mascarar.
const isHiddenFromView = (control, ancestors) => {
  if (control.position !== "fixed") return ancestors.some(isVisuallyHidden);
  const trap = ancestors.findIndex((ancestor) => ancestor.establishesFixedContainingBlock);
  return trap >= 0 && ancestors.findLastIndex(isVisuallyHidden) >= trap;
};

export function classifyControlReachability(control, viewport, ancestors = [], hitTests = [], proof = null, root = null) {
  const intersectsViewport = control.right > 0 && control.left < viewport.width && control.bottom > 0 && control.top < viewport.height;

  const fixed = control.position === "fixed";
  const fixedEscaped = fixed && !ancestors.some((ancestor) => ancestor.establishesFixedContainingBlock);
  if (isHiddenFromView(control, ancestors)) return { clipped: false, reason: "visually-hidden-ancestor", fixedEscaped };
  if (proof && !proof.verified) return { clipped: true, reason: proof.reason ?? "outside-viewport", fixedEscaped };
  const blocked = ancestors.find((ancestor) => {
    const outsideAxes = outside(control, ancestor);
    return (outsideAxes.x && !canReachOnAxis(control, ancestor, "x")) || (outsideAxes.y && !canReachOnAxis(control, ancestor, "y"));
  });
  if (proof?.verified && proof.hitTest && proof.reachable) {
    return { clipped: false, reason: proof.kind === "nested" ? "nested-scroll-reachable" : "document-scroll-reachable", fixedEscaped };
  }
  if (!intersectsViewport) return { clipped: true, reason: proof?.reason ?? "outside-viewport", fixedEscaped };
  if (!blocked) return { clipped: false, reason: fixedEscaped ? "fixed-escapes-overflow" : "reachable", fixedEscaped };
  if (fixedEscaped) return { clipped: false, reason: "fixed-escapes-overflow", fixedEscaped: true, ancestor: blocked.className };
  return { clipped: true, reason: hitTests.some(Boolean) ? "overflow-hit-test-inconclusive" : "overflow-unreachable", fixedEscaped: false, ancestor: blocked.className };
}

const box = (extra = {}) => ({ left: 0, top: 0, right: 20, bottom: 20, className: "overflow", overflowX: "hidden", overflowY: "hidden", ...extra });
const viewport = { width: 100, height: 100 };
export const geometrySelfTestVectors = [
  { name: "fixed control escapes overflow ancestor", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ establishesFixedContainingBlock: false })], hitTests: [true], expected: "fixed-escapes-overflow" },
  { name: "transformed fixed control remains clipped", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ className: "transform overflow-hidden", establishesFixedContainingBlock: true })], hitTests: [true], expected: "overflow-hit-test-inconclusive" },
  { name: "ordinary unreachable control", control: { left: 10, top: 10, right: 30, bottom: 30, position: "absolute" }, viewport, ancestors: [box()], hitTests: [false], expected: "overflow-unreachable" },
  { name: "vertical auto scroller reaches below fold", control: { left: 5, top: 80, right: 15, bottom: 100 }, viewport, ancestors: [box({ bottom: 50, overflowY: "auto", clientHeight: 50, scrollHeight: 150 })], hitTests: [false], expected: "reachable" },
  { name: "horizontal hidden overflow is unreachable", control: { left: 30, top: 5, right: 40, bottom: 15 }, viewport, ancestors: [box({ overflowX: "hidden", clientWidth: 20, scrollWidth: 100 })], hitTests: [false], expected: "overflow-unreachable" },
  { name: "nested scroll with outer clip", control: { left: 30, top: 30, right: 40, bottom: 40 }, viewport, ancestors: [box({ right: 35, bottom: 35, overflowX: "hidden", overflowY: "hidden" }), box({ overflowX: "auto", overflowY: "auto", clientWidth: 20, clientHeight: 20, scrollWidth: 100, scrollHeight: 100 })], hitTests: [false], expected: "overflow-unreachable" },
  { name: "viewport invisible is not a false pass", control: { left: 120, top: 10, right: 130, bottom: 20, position: "absolute" }, viewport, ancestors: [], hitTests: [], expected: "outside-viewport" },
  { name: "document scroll proof reaches below fold", control: { left: 10, top: 120, right: 30, bottom: 140 }, viewport, ancestors: [], hitTests: [false], proof: { verified: true, reachable: true, hitTest: true, kind: "document" }, root: { scrollableY: true }, expected: "document-scroll-reachable" },
  { name: "nested horizontal scroll proof reaches target", control: { left: 120, top: 10, right: 140, bottom: 30 }, viewport, ancestors: [box({ right: 100, overflowX: "auto", clientWidth: 100, scrollWidth: 300 })], hitTests: [false], proof: { verified: true, reachable: true, hitTest: true, kind: "nested" }, expected: "nested-scroll-reachable" },
  { name: "hidden clip cannot be proved by root scroll", control: { left: 10, top: 120, right: 30, bottom: 140 }, viewport, ancestors: [box({ bottom: 50, overflowY: "hidden", clientHeight: 50, scrollHeight: 150 })], hitTests: [false], proof: { verified: false, reason: "overflow-unreachable" }, expected: "overflow-unreachable" },
  { name: "offscreen fixed control remains a failure", control: { left: -50, top: 10, right: -10, bottom: 30, position: "fixed" }, viewport, ancestors: [], hitTests: [false], proof: { verified: false, reason: "outside-viewport" }, expected: "outside-viewport" },
  { name: "negative x menu with no scroller remains a failure", control: { left: -50, top: 10, right: -10, bottom: 30 }, viewport, ancestors: [], hitTests: [false], proof: { verified: false, reason: "outside-viewport" }, expected: "outside-viewport" },
  { name: "overlay remains a hit-test failure", control: { left: 10, top: 10, right: 30, bottom: 30 }, viewport, ancestors: [], hitTests: [false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "overflow-hit-test-inconclusive" },
  { name: "sr-only ancestor hides its control on purpose", control: { left: 10, top: 10, right: 30, bottom: 30 }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "visually-hidden-ancestor" },
  { name: "1px container without zero clip keeps failing", control: { left: 10, top: 10, right: 30, bottom: 30 }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "auto" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "overflow-hit-test-inconclusive" },
  { name: "1px zero-clip box in normal flow keeps failing", control: { left: 10, top: 10, right: 30, bottom: 30 }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "static", clip: "rect(0px, 0px, 0px, 0px)" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "overflow-hit-test-inconclusive" },
  { name: "large zero-clip card keeps failing", control: { left: 120, top: 10, right: 140, bottom: 30 }, viewport, ancestors: [box({ right: 100, bottom: 100, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "overflow-hit-test-inconclusive" },
  { name: "fixed control clipped by a transformed sr-only ancestor is exempted", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)", className: "sr-only transform", establishesFixedContainingBlock: true })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "visually-hidden-ancestor" },
  { name: "fixed control inside a transformed box below the sr-only ancestor is clipped by it", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ className: "transform", establishesFixedContainingBlock: true }), box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "visually-hidden-ancestor" },
  { name: "fixed control whose containing block sits above the sr-only ancestor escapes it", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" }), box({ className: "transform overflow-hidden", establishesFixedContainingBlock: true })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "overflow-hit-test-inconclusive" },
  { name: "fixed control escaping a sr-only ancestor is not exempted", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "overflow-hit-test-inconclusive" },
  { name: "fixed control trapped by an outer sr-only ancestor through a transformed box is exempted", control: { left: 10, top: 10, right: 30, bottom: 30, position: "fixed" }, viewport, ancestors: [box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" }), box({ className: "transform", establishesFixedContainingBlock: true }), box({ left: 12, top: 12, right: 13, bottom: 13, position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" })], hitTests: [false, false, false], proof: { verified: false, reason: "overflow-hit-test-inconclusive" }, expected: "visually-hidden-ancestor" },
];
