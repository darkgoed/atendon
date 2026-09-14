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

export function classifyControlReachability(control, viewport, ancestors = [], hitTests = [], proof = null, root = null) {
  const intersectsViewport = control.right > 0 && control.left < viewport.width && control.bottom > 0 && control.top < viewport.height;

  const fixed = control.position === "fixed";
  const fixedEscaped = fixed && !ancestors.some((ancestor) => ancestor.establishesFixedContainingBlock);
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
];
