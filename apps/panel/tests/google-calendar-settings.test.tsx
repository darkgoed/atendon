// @vitest-environment jsdom
// Google Agenda (SPEC google-calendar-team-sync): contas conectadas por atendente,
// escolha de agenda gravável, rotas pipeline→equipe/conexão e início do OAuth.
// O mock do backend responde pela sessão ativa, como o cookie.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { GoogleCalendarSettings } from "@/components/google-calendar-settings";

type TestConnection = {
  id: string;
  member_id: string;
  email: string;
  calendar_id: string | null;
  calendar_name: string | null;
  calendar_timezone: string | null;
  buffer_minutes: number | null;
  auth_error?: string | null;
};
type TestRoute = { pipeline_id: string; team_id: string | null; connection_id: string | null };

const mariaConnected: TestConnection = {
  id: "c-1",
  member_id: "m-1",
  email: "maria@example.com",
  calendar_id: "cal-1",
  calendar_name: "Agenda da Maria",
  calendar_timezone: "America/Sao_Paulo",
  buffer_minutes: 15
};
const joaoWithoutCalendar: TestConnection = {
  id: "c-2",
  member_id: "m-3",
  email: "joao@example.com",
  calendar_id: null,
  calendar_name: null,
  calendar_timezone: null,
  buffer_minutes: 30
};

const state = {
  connections: [mariaConnected, joaoWithoutCalendar] as TestConnection[],
  routes: [] as TestRoute[],
  putCalls: [] as Array<{ path: string; body: unknown }>,
  failCalendarPut: false
};

const assignMock = vi.fn();

// jsdom roda em http://localhost:3000/ — o replaceState do callback OAuth exige
// mesma origem entre o href falso e a URL do documento. O callback real do
// backend volta para a rota aninhada /configuracoes/google-calendar?calendar_oauth=….
function setLocation(href: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost:3000", href, assign: assignMock }
  });
}

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <GoogleCalendarSettings canManage />
    </SWRConfig>
  );
}

beforeEach(() => {
  state.connections = [mariaConnected, joaoWithoutCalendar];
  state.routes = [];
  state.putCalls = [];
  state.failCalendarPut = false;
  assignMock.mockReset();
  setLocation("http://localhost:3000/configuracoes/google-calendar");
  apiMock.mockReset();
  apiMock.mockImplementation((path: string, options?: RequestInit) => {
    if (path === "/scheduling/google-calendar/connections") return Promise.resolve({ configured: true, connections: state.connections });
    if (path === "/scheduling/config/attendants") return Promise.resolve({ attendants: [{ member_id: "m-2", email: "novo@example.com" }], member_ids: ["m-2"] });
    if (path === "/scheduling/google-calendar/routes" && !options?.method) return Promise.resolve({ routes: state.routes });
    if (path === "/organization/pipelines") return Promise.resolve({ pipelines: [{ id: "p-1", name: "Vendas", archived_at: null }] });
    if (path === "/organization/teams") return Promise.resolve({ teams: [{ id: "t-1", name: "Suporte" }] });
    if (path === "/scheduling/google-calendar/connections/c-1/calendars") {
      return Promise.resolve({ calendars: [{ id: "cal-2", name: "Atendimentos", timezone: "America/Sao_Paulo", primary: false }] });
    }
    if (path === "/scheduling/google-calendar/connections/c-1/calendar" && options?.method === "PUT") {
      if (state.failCalendarPut) return Promise.reject(new Error("Calendário inválido ou sem permissão de escrita"));
      const body = JSON.parse(String(options.body));
      state.putCalls.push({ path, body });
      state.connections = state.connections.map((connection) => connection.id === "c-1"
        ? { ...connection, calendar_id: body.calendar_id, calendar_name: "Atendimentos", calendar_timezone: "America/Sao_Paulo" }
        : connection);
      return Promise.resolve({});
    }
    const bufferMatch = path.match(/^\/scheduling\/google-calendar\/connections\/([^/]+)\/buffer$/);
    if (bufferMatch && options?.method === "PATCH") {
      const body = JSON.parse(String(options.body));
      state.putCalls.push({ path, body });
      state.connections = state.connections.map((connection) => connection.id === bufferMatch[1]
        ? { ...connection, buffer_minutes: body.buffer_minutes }
        : connection);
      return Promise.resolve({});
    }
    if (path === "/scheduling/google-calendar/routes" && options?.method === "PUT") {
      const body = JSON.parse(String(options.body));
      state.putCalls.push({ path, body });
      state.routes = [{ pipeline_id: body.pipeline_id, team_id: body.team_id ?? null, connection_id: body.connection_id ?? null }];
      return Promise.resolve({});
    }
    if (path === "/scheduling/google-calendar/routes/p-1" && options?.method === "DELETE") {
      state.routes = [];
      return Promise.resolve({});
    }
    if (path.startsWith("/scheduling/google-calendar/oauth/start?member_id=")) {
      return Promise.resolve({ authorization_url: "https://accounts.google.com/o/oauth2/auth?state=nonce" });
    }
    return Promise.reject(new Error(`rota inesperada ${options?.method ?? "GET"} ${path}`));
  });
});
afterEach(() => cleanup());

describe("Google Agenda — configuração por atendente", () => {
  it("mostra status por conta: agenda escolhida com fuso e aviso quando falta agenda", async () => {
    renderPanel();

    const accounts = within(await screen.findByRole("list", { name: "Contas Google conectadas" }));
    expect(accounts.getByText("maria@example.com")).toBeInTheDocument();
    expect(accounts.getByText(/Agenda: Agenda da Maria · fuso America\/Sao_Paulo/)).toBeInTheDocument();
    expect(accounts.getByText("joao@example.com")).toBeInTheDocument();
    expect(accounts.getByText(/Sem agenda selecionada/)).toBeInTheDocument();
  });

  it("carrega agendas graváveis ao interagir e salva a escolhida com PUT {calendar_id}", async () => {
    const user = userEvent.setup();
    renderPanel();

    const combobox = await screen.findByRole("combobox", { name: "Agenda de maria@example.com" });
    await user.click(combobox); // foco/abertura dispara o carregamento das agendas
    await screen.findByRole("option", { name: "Atendimentos" });
    fireEvent.change(combobox, { target: { value: "cal-2" } });

    await waitFor(() => expect(state.putCalls).toContainEqual({
      path: "/scheduling/google-calendar/connections/c-1/calendar",
      body: { calendar_id: "cal-2" }
    }));
    expect(await screen.findByText(/Agenda: Atendimentos/)).toBeInTheDocument();
  });

  it("salva rota pipeline→equipe e remove o override ao voltar para o padrão", async () => {
    state.routes = [{ pipeline_id: "p-1", team_id: null, connection_id: "c-1" }];
    renderPanel();

    const combobox = await screen.findByRole("combobox", { name: "Agenda do pipeline Vendas" });
    await screen.findByRole("option", { name: "Suporte" });
    fireEvent.change(combobox, { target: { value: "team:t-1" } });
    await waitFor(() => expect(state.putCalls).toContainEqual({
      path: "/scheduling/google-calendar/routes",
      body: { pipeline_id: "p-1", team_id: "t-1" }
    }));
    await waitFor(() => expect(combobox).toHaveValue("team:t-1"));

    fireEvent.change(combobox, { target: { value: "" } });
    await waitFor(() => {
      expect(apiMock.mock.calls.some(([path, options]) => path === "/scheduling/google-calendar/routes/p-1" && (options as RequestInit | undefined)?.method === "DELETE")).toBe(true);
    });
    await waitFor(() => expect(combobox).toHaveValue(""));
  });

  it("inicia o OAuth do atendente escolhido e navega para a authorization_url", async () => {
    const user = userEvent.setup();
    renderPanel();

    const combobox = await screen.findByRole("combobox", { name: "Atendente para conectar" });
    await screen.findByRole("option", { name: "novo@example.com" });
    fireEvent.change(combobox, { target: { value: "m-2" } });
    await user.click(screen.getByRole("button", { name: "Conectar com Google" }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?state=nonce"));
    expect(apiMock.mock.calls.some(([path]) => path === "/scheduling/google-calendar/oauth/start?member_id=m-2")).toBe(true);
  });

  it("conta com acesso revogado no Google avisa e reconecta pelo OAuth do mesmo atendente", async () => {
    state.connections = [{ ...mariaConnected, auth_error: "O acesso ao Google Agenda foi revogado ou expirou; reconecte a conta" }, joaoWithoutCalendar];
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText(/O Google recusou o acesso desta conta/)).toBeInTheDocument();
    // Só a conta revogada mostra o aviso.
    expect(screen.getAllByRole("button", { name: "Reconectar com Google" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Reconectar com Google" }));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?state=nonce"));
    expect(apiMock.mock.calls.some(([path]) => path === "/scheduling/google-calendar/oauth/start?member_id=m-1")).toBe(true);
  });

  it("mostra feedback do callback OAuth quando o login é cancelado e o replaceState mantém a rota aninhada", async () => {
    setLocation("http://localhost:3000/configuracoes/google-calendar?calendar_oauth=denied");
    const replaceState = vi.spyOn(window.history, "replaceState");
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("O login com o Google foi cancelado.");
    // O parâmetro calendar_oauth sai, mas o segmento aninhado /configuracoes/google-calendar fica.
    expect(String(replaceState.mock.calls[0]?.[2] ?? "")).toBe("http://localhost:3000/configuracoes/google-calendar");
    replaceState.mockRestore();
  });

  it("mostra o erro do backend e mantém a agenda anterior quando o PUT falha", async () => {
    const user = userEvent.setup();
    state.failCalendarPut = true;
    renderPanel();

    const combobox = await screen.findByRole("combobox", { name: "Agenda de maria@example.com" });
    await user.click(combobox);
    await screen.findByRole("option", { name: "Atendimentos" });
    fireEvent.change(combobox, { target: { value: "cal-2" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Calendário inválido ou sem permissão de escrita");
    expect(screen.queryByText(/Agenda: Atendimentos/)).not.toBeInTheDocument();
    expect(screen.getByText(/Agenda: Agenda da Maria/)).toBeInTheDocument();
    expect(apiMock.mock.calls.some(([path]) => path === "/scheduling/google-calendar/connections/c-1/calendar")).toBe(true);
  });

  it("salva o intervalo de cada conta de forma independente com PATCH {buffer_minutes}", async () => {
    renderPanel();

    const inputMaria = await screen.findByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" });
    expect(inputMaria).toHaveValue(15);
    const inputJoao = screen.getByRole("spinbutton", { name: "Intervalo entre eventos de joao@example.com" });
    expect(inputJoao).toHaveValue(30);

    fireEvent.change(inputMaria, { target: { value: "20" } });
    fireEvent.blur(inputMaria);

    await waitFor(() => expect(state.putCalls).toContainEqual({
      path: "/scheduling/google-calendar/connections/c-1/buffer",
      body: { buffer_minutes: 20 }
    }));
    expect(await screen.findByText("Configurações salvas")).toBeInTheDocument();
    expect(state.putCalls.filter((call) => call.path.includes("/c-2/"))).toEqual([]);
    expect(await screen.findByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" })).toHaveValue(20);
    expect(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de joao@example.com" })).toHaveValue(30);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de joao@example.com" }), { target: { value: "45" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de joao@example.com" }));

    await waitFor(() => expect(state.putCalls).toContainEqual({
      path: "/scheduling/google-calendar/connections/c-2/buffer",
      body: { buffer_minutes: 45 }
    }));
    expect(state.putCalls.filter((call) => call.path === "/scheduling/google-calendar/connections/c-1/buffer")).toHaveLength(1);
    expect(await screen.findByRole("spinbutton", { name: "Intervalo entre eventos de joao@example.com" })).toHaveValue(45);
    expect(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" })).toHaveValue(20);
  });

  it("valida o intervalo entre 0 e 240 antes de chamar a API", async () => {
    renderPanel();

    const inputMaria = await screen.findByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" });
    fireEvent.change(inputMaria, { target: { value: "300" } });
    fireEvent.blur(inputMaria);

    expect(await screen.findByRole("alert")).toHaveTextContent("O intervalo deve estar entre 0 e 240 minutos.");
    expect(state.putCalls).toEqual([]);
    expect(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" })).toHaveValue(15);

    fireEvent.change(inputMaria, { target: { value: "-5" } });
    fireEvent.blur(inputMaria);
    expect(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" })).toHaveValue(15);

    fireEvent.change(inputMaria, { target: { value: "240" } });
    fireEvent.blur(inputMaria);
    await waitFor(() => expect(state.putCalls).toContainEqual({
      path: "/scheduling/google-calendar/connections/c-1/buffer",
      body: { buffer_minutes: 240 }
    }));
    expect(await screen.findByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" })).toHaveValue(240);
  });

  it("intervalo vazio não salva 0: mostra erro e mantém o valor", async () => {
    renderPanel();

    const inputMaria = await screen.findByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" });
    fireEvent.change(inputMaria, { target: { value: "" } });
    fireEvent.blur(inputMaria);

    expect(await screen.findByRole("alert")).toHaveTextContent("O intervalo deve estar entre 0 e 240 minutos.");
    expect(state.putCalls).toEqual([]);
    expect(screen.getByRole("spinbutton", { name: "Intervalo entre eventos de maria@example.com" })).toHaveValue(15);
  });

  it("rota por conta só oferece contas com agenda selecionada", async () => {
    renderPanel();

    await screen.findByRole("combobox", { name: "Agenda do pipeline Vendas" });
    expect(await screen.findByRole("option", { name: "maria@example.com" })).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "joao@example.com (sem agenda selecionada)" })).toBeDisabled();
  });
});
