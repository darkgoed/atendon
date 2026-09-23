// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

apiMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
  if (url === "/scheduling/config/unidades") return Promise.resolve({ unidades: [{ id: "u1", nome: "Matriz" }] });
  if (url === "/scheduling/config/categorias") return Promise.resolve({ categorias: [{ id: "c1", nome: "Pousada" }] });
  if (url === "/scheduling/config/parceiros") return Promise.resolve({ parceiros: [] });
  if (url === "/scheduling/leads" && init?.method === "POST") return Promise.resolve({ lead: { id: "lead-new" } });
  return Promise.resolve({});
});

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { NewLeadDialog } from "../components/new-lead-dialog";

afterEach(cleanup);
beforeEach(() => apiMock.mockClear());

describe("NewLeadDialog", () => {
  it("renderiza, valida telefone e envia só os campos preenchidos", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<NewLeadDialog open onClose={vi.fn()} onCreated={onCreated} />);

    const dialog = await screen.findByRole("dialog", { name: "Novo contato" });
    expect(dialog).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Criar contato" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Telefone / WhatsApp"), "11 91234-5678");
    expect(submit).toBeEnabled();

    await user.type(screen.getByLabelText("Nome"), "Maria");
    await user.type(screen.getByLabelText("Origem (opcional)"), "Indicação");
    await user.type(screen.getByLabelText("Campanha (opcional)"), "Meta agosto");

    await user.click(submit);

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/scheduling/leads", expect.objectContaining({ method: "POST" })));
    const body = JSON.parse(apiMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body ?? "{}");
    expect(body).toEqual({ telefone: "11 91234-5678", nome: "Maria", origem: "Indicação", campanha: "Meta agosto" });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("recusa telefone incompleto sem chamar a API", async () => {
    const user = userEvent.setup();
    render(<NewLeadDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("dialog", { name: "Novo contato" });

    await user.type(screen.getByLabelText("Telefone / WhatsApp"), "11 9123");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));
    // onSubmit é bloqueado: formulário nativo required + botão disabled
    expect(apiMock).not.toHaveBeenCalledWith("/scheduling/leads", expect.objectContaining({ method: "POST" }));
    expect(screen.getByRole("dialog", { name: "Novo contato" })).toBeInTheDocument();
  });

  it("mostra erro da API dentro do dialog", async () => {
    apiMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === "POST") return Promise.reject(new Error("Telefone já cadastrado"));
      if (url === "/scheduling/config/unidades") return Promise.resolve({ unidades: [] });
      if (url === "/scheduling/config/categorias") return Promise.resolve({ categorias: [] });
      if (url === "/scheduling/config/parceiros") return Promise.resolve({ parceiros: [] });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<NewLeadDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("dialog", { name: "Novo contato" });

    await user.type(screen.getByLabelText("Telefone / WhatsApp"), "11 91234-5678");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Telefone já cadastrado");
expect(screen.getByRole("dialog", { name: "Novo contato" })).toBeInTheDocument();
  });
});
