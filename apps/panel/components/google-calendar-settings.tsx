"use client";

// Google Agenda por atendente (SPEC google-calendar-team-sync): contas conectadas
// por membro, escolha de agenda com permissão de escrita e rotas pipeline→equipe
// ou conexão específica. Tokens ficam no servidor; o painel só recebe metadados.

import { CalendarDots, GoogleLogo, LinkBreak } from "@/components/icons";
import { type FormEvent, useEffect, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import type { PipelinesResponse } from "@/lib/pipeline";
import { IconButton, SaveToast, useSaveFeedback } from "@/components/ui";

type CalendarConnection = {
  id: string;
  member_id: string;
  email: string;
  calendar_id: string | null;
  calendar_name: string | null;
  calendar_timezone: string | null;
  buffer_minutes: number | null;
  // Google recusou a renovação (acesso revogado/expirado): pede reconexão.
  auth_error?: string | null;
};
type ConnectionsResponse = { configured: boolean; connections: CalendarConnection[] };
type CalendarOption = { id: string; name: string; timezone: string | null; primary: boolean };
type CalendarsResponse = { calendars: CalendarOption[] };
type CalendarRoute = { pipeline_id: string; team_id: string | null; connection_id: string | null };
type RoutesResponse = { routes: CalendarRoute[] };
type TeamsResponse = { teams: { id: string; name: string }[] };
type AttendantsResponse = { attendants: { member_id: string; email: string }[] };

export function GoogleCalendarSettings({ canManage }: { canManage: boolean }) {
  const save = useSaveFeedback();
  const [error, setError] = useState("");
  const [oauthFeedback, setOauthFeedback] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [calendarsByConnection, setCalendarsByConnection] = useState<Record<string, CalendarOption[]>>({});
  const [loadingCalendarsId, setLoadingCalendarsId] = useState("");
  const [busyConnectionId, setBusyConnectionId] = useState("");
  const [busyRoutePipelineId, setBusyRoutePipelineId] = useState("");
  const [bufferDrafts, setBufferDrafts] = useState<Record<string, string>>({});

  const { data: connectionsData, error: connectionsError, isLoading, mutate: mutateConnections } = useSWR<ConnectionsResponse>(
    "/scheduling/google-calendar/connections",
    (url: string) => api<ConnectionsResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const { data: attendantsData } = useSWR<AttendantsResponse>(
    canManage ? "/scheduling/config/attendants" : null,
    (url: string) => api<AttendantsResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const { data: routesData, error: routesError, mutate: mutateRoutes } = useSWR<RoutesResponse>(
    "/scheduling/google-calendar/routes",
    (url: string) => api<RoutesResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const { data: pipelinesData, error: pipelinesError } = useSWR<PipelinesResponse>(
    "/organization/pipelines",
    (url: string) => api<PipelinesResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const { data: teamsData, error: teamsError } = useSWR<TeamsResponse>(
    "/organization/teams",
    (url: string) => api<TeamsResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  // Callback OAuth volta para a rota aninhada /configuracoes/google-calendar?calendar_oauth=…
  // (a página remonta do zero; o SWR recarrega as contas sozinho).
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("calendar_oauth");
    if (result === "connected") setOauthFeedback("Conta Google conectada. Escolha a agenda do atendente.");
    else if (result === "denied") setError("O login com o Google foi cancelado.");
    else if (result === "error") setError("Não foi possível conectar a conta Google. Tente novamente.");
    if (result) {
      url.searchParams.delete("calendar_oauth");
      window.history.replaceState({}, "", url);
    }
  }, []);

  const connections = connectionsData?.connections ?? [];
  const connectableAttendants = (attendantsData?.attendants ?? [])
    .filter((attendant) => !connections.some((connection) => connection.member_id === attendant.member_id));
  const activePipelines = (pipelinesData?.pipelines ?? []).filter((pipeline) => !pipeline.archived_at);

  async function connectGoogle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await startGoogleOauth(selectedMemberId);
  }

  // Reconectar (acesso revogado) reaproveita o mesmo fluxo OAuth do atendente.
  async function startGoogleOauth(memberId: string) {
    if (!canManage || !memberId || connecting) return;
    setConnecting(true);
    setError("");
    try {
      const response = await api<{ authorization_url: string }>(`/scheduling/google-calendar/oauth/start?member_id=${encodeURIComponent(memberId)}`);
      window.location.assign(response.authorization_url);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Falha ao iniciar o login com o Google");
      setConnecting(false);
    }
  }

  async function ensureCalendars(connection: CalendarConnection) {
    if (!canManage || calendarsByConnection[connection.id] || loadingCalendarsId === connection.id) return;
    setLoadingCalendarsId(connection.id);
    setError("");
    try {
      const response = await api<CalendarsResponse>(`/scheduling/google-calendar/connections/${connection.id}/calendars`);
      setCalendarsByConnection((current) => ({ ...current, [connection.id]: response.calendars }));
    } catch (calendarsError) {
      setError(calendarsError instanceof Error ? calendarsError.message : "Falha ao carregar as agendas");
    } finally {
      setLoadingCalendarsId("");
    }
  }

  async function chooseCalendar(connection: CalendarConnection, calendarId: string) {
    if (!canManage || !calendarId || calendarId === connection.calendar_id || busyConnectionId === connection.id) return;
    setBusyConnectionId(connection.id);
    setError("");
    try {
      await api(`/scheduling/google-calendar/connections/${connection.id}/calendar`, {
        method: "PUT",
        body: JSON.stringify({ calendar_id: calendarId })
      });
      await mutateConnections();
      save.markDone();
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : "Falha ao salvar a agenda");
    } finally {
      setBusyConnectionId("");
    }
  }

  async function setBuffer(connection: CalendarConnection, rawValue: string) {
    if (!canManage || busyConnectionId === connection.id) return;
    const minutes = rawValue.trim() === "" ? Number.NaN : Number(rawValue);
    const clearDraft = () => setBufferDrafts((current) => {
      const next = { ...current };
      delete next[connection.id];
      return next;
    });
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) {
      clearDraft();
      setError("O intervalo deve estar entre 0 e 240 minutos.");
      return;
    }
    if (minutes === connection.buffer_minutes) {
      clearDraft();
      return;
    }
    setBusyConnectionId(connection.id);
    setError("");
    try {
      await api(`/scheduling/google-calendar/connections/${connection.id}/buffer`, {
        method: "PATCH",
        body: JSON.stringify({ buffer_minutes: minutes })
      });
      await mutateConnections();
      save.markDone();
    } catch (bufferError) {
      setError(bufferError instanceof Error ? bufferError.message : "Falha ao salvar o intervalo");
    } finally {
      clearDraft();
      setBusyConnectionId("");
    }
  }

  async function disconnect(connection: CalendarConnection) {
    if (!canManage || busyConnectionId === connection.id || !window.confirm(`Desconectar a conta ${connection.email} do Google Agenda?`)) return;
    setBusyConnectionId(connection.id);
    setError("");
    try {
      await api(`/scheduling/google-calendar/connections/${connection.id}`, { method: "DELETE" });
      await mutateConnections();
      save.markDone();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Falha ao desconectar a conta");
    } finally {
      setBusyConnectionId("");
    }
  }

  async function setRoute(pipelineId: string, value: string) {
    if (!canManage || busyRoutePipelineId) return;
    setBusyRoutePipelineId(pipelineId);
    setError("");
    try {
      if (value === "") {
        if (routesData?.routes.some((route) => route.pipeline_id === pipelineId)) {
          await api(`/scheduling/google-calendar/routes/${pipelineId}`, { method: "DELETE" });
        }
      } else if (value.startsWith("team:")) {
        await api("/scheduling/google-calendar/routes", {
          method: "PUT",
          body: JSON.stringify({ pipeline_id: pipelineId, team_id: value.slice("team:".length) })
        });
      } else if (value.startsWith("conn:")) {
        await api("/scheduling/google-calendar/routes", {
          method: "PUT",
          body: JSON.stringify({ pipeline_id: pipelineId, connection_id: value.slice("conn:".length) })
        });
      }
      await mutateRoutes();
      save.markDone();
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : "Falha ao salvar a rota");
    } finally {
      setBusyRoutePipelineId("");
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-3xl border-t border-[var(--border)] pt-6" aria-busy="true" aria-label="Carregando configuração do Google Agenda">
        <div className="grid gap-4">
          <div className="skeleton h-8 w-2/5" />
          <div className="skeleton h-28" />
        </div>
      </div>
    );
  }

  return (
    <section className="max-w-3xl border-t border-[var(--border)] pt-6" aria-labelledby="google-calendar-head">
      <div className="grid gap-5">
        <div className="grid gap-5 sm:grid-cols-[40px_minmax(0,1fr)]">
          <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--border)] text-[var(--primary-text)]">
            <CalendarDots size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 id="google-calendar-head" className="m-0 text-base font-semibold text-[var(--text)]">Google Agenda</h2>
            <p className="sub mt-1">
              Conecta a agenda Google de cada atendente e escolhe qual agenda recebe os eventos. Independente da conta global do Google Meet.
            </p>
          </div>
        </div>

        {error ? <p className="error" role="alert">{error}</p> : null}
        {oauthFeedback ? <p className="text-sm text-[var(--primary-text)]" role="status">{oauthFeedback}</p> : null}
        {connectionsData?.configured === false ? (
          <p className="error" role="alert">O Client ID OAuth do Google ainda não foi configurado no servidor.</p>
        ) : null}

        <section aria-label="Contas Google conectadas">
          <h3 className="text-sm font-semibold">Contas conectadas</h3>
          {connectionsError ? (
            <p className="error mt-2 text-xs" role="alert">{connectionsError instanceof Error ? connectionsError.message : "Falha ao carregar as contas conectadas."}</p>
          ) : connections.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Nenhuma conta conectada.</p>
          ) : (
            <ul aria-label="Contas Google conectadas" className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
              {connections.map((connection) => {
                const options = calendarsByConnection[connection.id];
                return (
                  <li key={connection.id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <strong className="block truncate text-sm">{connection.email}</strong>
                        {connection.calendar_id ? (
                          <span className="sub mt-1 block text-xs">
                            Agenda: {connection.calendar_name ?? connection.calendar_id}
                            {connection.calendar_timezone ? ` · fuso ${connection.calendar_timezone}` : ""}
                          </span>
                        ) : (
                          <span className="mt-1 block text-xs text-[var(--warning-text)]">Sem agenda selecionada — a sincronização deste atendente fica desativada.</span>
                        )}
                        {connection.auth_error ? (
                          <span className="mt-1 block text-xs text-[var(--warning-text)]" role="alert">
                            O Google recusou o acesso desta conta (revogado ou expirado); a sincronização está parada.{" "}
                            {canManage ? (
                              <button
                                type="button"
                                className="underline"
                                disabled={connecting}
                                onClick={() => void startGoogleOauth(connection.member_id)}
                              >
                                Reconectar com Google
                              </button>
                            ) : "Peça a um administrador para reconectar."}
                          </span>
                        ) : null}
                      </div>
                      {canManage ? (
                        <IconButton
                          label={`Desconectar ${connection.email}`}
                          disabled={busyConnectionId === connection.id}
                          onClick={() => void disconnect(connection)}
                        >
                          {busyConnectionId === connection.id ? <span className="on-spinner" aria-hidden="true" /> : <LinkBreak size={17} aria-hidden="true" />}
                        </IconButton>
                      ) : null}
                    </div>
                    {canManage ? (
                      <label className="field mt-3">
                        <span className="label">Agenda do atendente</span>
                        <select
                          className="input"
                          value={connection.calendar_id ?? ""}
                          disabled={busyConnectionId === connection.id}
                          aria-label={`Agenda de ${connection.email}`}
                          onFocus={() => void ensureCalendars(connection)}
                          onChange={(event) => void chooseCalendar(connection, event.target.value)}
                        >
                          {connection.calendar_id ? (
                            <option value={connection.calendar_id}>{connection.calendar_name ?? connection.calendar_id}</option>
                          ) : (
                            <option value="">Selecione uma agenda</option>
                          )}
                          {(options ?? [])
                            .filter((option) => option.id !== connection.calendar_id)
                            .map((option) => (
                              <option key={option.id} value={option.id}>{option.name}{option.primary ? " (principal)" : ""}</option>
                            ))}
                        </select>
                        <small className="sub">
                          {loadingCalendarsId === connection.id ? "Carregando agendas…" : "Somente agendas em que a conta pode escrever. A escolha habilita a sincronização."}
                        </small>
                      </label>
                    ) : null}
                    {canManage ? (
                      <label className="field mt-3">
                        <span className="label">Intervalo entre eventos (minutos)</span>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={240}
                          step={1}
                          value={bufferDrafts[connection.id] ?? String(connection.buffer_minutes ?? 0)}
                          disabled={busyConnectionId === connection.id}
                          aria-label={`Intervalo entre eventos de ${connection.email}`}
                          onChange={(event) => setBufferDrafts((current) => ({ ...current, [connection.id]: event.target.value }))}
                          onBlur={(event) => void setBuffer(connection, event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                        />
                        <small className="sub">
                          Minutos bloqueados antes e depois de cada evento na agenda deste atendente (0 a 240). Enter ou Tab salva.
                        </small>
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canManage ? (
          <form className="grid gap-4 border-t border-[var(--border)] pt-5" onSubmit={connectGoogle}>
            <h3 className="text-sm font-semibold">Conectar conta Google</h3>
            <p className="sub text-xs">Entre com a conta Google do atendente escolhido. O acesso renovável é criptografado no servidor; a senha nunca passa pelo AtendON.</p>
            <label className="field">
              <span className="label">Atendente</span>
              <select
                className="input"
                value={selectedMemberId}
                onChange={(event) => setSelectedMemberId(event.target.value)}
                aria-label="Atendente para conectar"
              >
                <option value="">Selecione um atendente</option>
                {connectableAttendants.map((attendant) => (
                  <option key={attendant.member_id} value={attendant.member_id}>{attendant.email}</option>
                ))}
              </select>
            </label>
            <div>
              <button type="submit" className="btn primary active:scale-[0.98]" disabled={!selectedMemberId || connecting}>
                <GoogleLogo size={17} weight="bold" aria-hidden="true" /> {connecting ? "Abrindo Google…" : "Conectar com Google"}
              </button>
            </div>
          </form>
        ) : null}

        <section className="border-t border-[var(--border)] pt-5" aria-label="Rotas de agenda por pipeline">
          <h3 className="text-sm font-semibold">Rotas por pipeline</h3>
          <p className="sub mt-1 text-xs">
            Define quem recebe os eventos de cada pipeline: a agenda do responsável (padrão), uma equipe (escolhida entre os membros dela) ou uma conta conectada específica.
          </p>
          {routesError || pipelinesError || teamsError ? (
            <p className="error mt-2 text-xs" role="alert">
              {routesError instanceof Error ? routesError.message
                : pipelinesError instanceof Error ? pipelinesError.message
                : teamsError instanceof Error ? teamsError.message : "Falha ao carregar as rotas."}
            </p>
          ) : null}
          {activePipelines.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Nenhum pipeline ativo.</p>
          ) : (
            <ul aria-label="Rotas de agenda por pipeline" className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
              {activePipelines.map((pipeline) => {
                const route = routesData?.routes.find((item) => item.pipeline_id === pipeline.id);
                const value = route?.team_id ? `team:${route.team_id}` : route?.connection_id ? `conn:${route.connection_id}` : "";
                return (
                  <li key={pipeline.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <span className="text-sm font-medium">{pipeline.name}</span>
                    <label className="field min-w-0 flex-1 sm:max-w-80">
                      <span className="sr-only">Agenda do pipeline {pipeline.name}</span>
                      <select
                        className="input"
                        value={value}
                        disabled={Boolean(busyRoutePipelineId)}
                        onChange={(event) => void setRoute(pipeline.id, event.target.value)}
                      >
                        <option value="">Padrão: agenda do responsável</option>
                        <optgroup label="Equipes">
                          {(teamsData?.teams ?? []).map((team) => (
                            <option key={team.id} value={`team:${team.id}`}>{team.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Contas conectadas">
                          {connections.map((connection) => {
                            const optionValue = `conn:${connection.id}`;
                            // Sem agenda escolhida a rota não tem destino (backend responde 409).
                            const unconfigured = !connection.calendar_id;
                            return (
                              <option key={connection.id} value={optionValue} disabled={unconfigured && optionValue !== value}>
                                {connection.email}{unconfigured ? " (sem agenda selecionada)" : ""}
                              </option>
                            );
                          })}
                        </optgroup>
                      </select>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <SaveToast show={save.done}>Configurações salvas</SaveToast>
    </section>
  );
}
