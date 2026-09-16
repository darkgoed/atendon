// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacidade/page";
import { metadata } from "@/app/privacidade/layout";

const RESIDUE = /rascunho|antes da publicação|documento em revisão|versão final deverá|ser confirmado/i;

afterEach(cleanup);

describe("public privacy policy", () => {
  it("renders a coherent published notice for AtendON and Instagram Direct", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("heading", { name: "Política de privacidade" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Informações do responsável/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Quando a conversa chega pela Meta/ })).toBeInTheDocument();
    expect(screen.getByText(/revogar a autorização na Meta não é o mesmo que pedir exclusão/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Como solicitar exclusão" })).toBeInTheDocument();
    expect(screen.getByText(/Solicitação de exclusão de dados — AtendON/)).toBeInTheDocument();
    expect(screen.getByText(/não possui uma política geral automatizada de expurgo/)).toBeInTheDocument();

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(RESIDUE);
    expect(text).toContain("política publicada");
  });

  it("publishes verified identity, contact, deletion instructions, and canonical metadata", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";

    expect(text).toContain("Arthur de Almeida Brittes Muller Amorim");
    expect(text).toContain("64.988.692/0001-00");
    expect(text).toContain("Guaratinguetá-SP");
    expect(text).toContain("arthurmuller07@gmail.com");
    expect(text).toContain("envie um e-mail");
    expect(text).not.toContain("12.345.678/0001-99");
    expect(text).not.toMatch(/(?:placeholder|exemplo|example)@/i);
    expect(text).not.toContain("123.456");
    expect(text).not.toContain("exemplo.com");
    expect(metadata.robots).toMatchObject({ index: true, follow: true });
    expect(metadata.alternates).toEqual({ canonical: "https://atendon.alpdash.com.br/privacidade" });
    expect(metadata.openGraph).toMatchObject({ url: "https://atendon.alpdash.com.br/privacidade" });
    expect(metadata.title).toBe("Política de privacidade");
    expect(screen.getByRole("link", { name: "AtendON" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Voltar ao login" })).toHaveAttribute("href", "/login");
  });
});
