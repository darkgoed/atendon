import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Fonte, não teatro (spec sino-unico-topbar): as três verdades do sino único
// checadas contra o código que roda, em ambiente node (sem DOM necessário).
const shell = readFileSync(resolve(__dirname, "../components/shell.tsx"), "utf8");
const moduleCss = readFileSync(resolve(__dirname, "../components/internal-notifications.module.css"), "utf8");
const feedback = readFileSync(resolve(__dirname, "../styles/domains/feedback.css"), "utf8");

describe("sino único na topbar", () => {
  it("shell.tsx não importa/renderiza mais o NotificationCenter", () => {
    expect(shell).not.toContain("NotificationCenter");
    expect(shell).not.toContain("notification-center");
  });

  it(".trigger do sino interno não é mais FAB (position:fixed) no canto inferior direito", () => {
    const trigger = moduleCss.match(/\.trigger\s*\{[^}]*\}/)?.[0] ?? "";
    expect(trigger).toBeTruthy();
    expect(trigger).not.toContain("position: fixed");
  });

  it("feedback.css não guarda mais nenhum bloco .notification-center*", () => {
    expect(feedback).not.toContain("notification-center");
  });
});
