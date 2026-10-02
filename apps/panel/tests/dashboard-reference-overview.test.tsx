// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { DashboardReferenceOverview } from '../components/dashboard-reference-overview'

// Capabilities configuráveis por teste: o padrão é tudo ativo.
const caps = { appointments: true, leads: true, pipeline: true };
vi.mock('@/lib/capabilities', () => ({
  useCapabilities: () => ({
    isEnabled: (key: string) =>
      key === 'appointments_v1' ? caps.appointments : key === 'leads_v1' ? caps.leads : caps.pipeline
  })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  caps.appointments = true;
  caps.leads = true;
  caps.pipeline = true;
})

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const forbidden = () =>
  new Response(JSON.stringify({ message: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })

const endpoints: Record<string, unknown> = {
  commercial_metrics: {
    data: {
      result: { new_contacts: 48, appointments: 21, calls: 18, sales: 9, sold_value: 13500, average_ticket: 1500, due_meetings: 20, no_show: 3 },
      funnel: { lead_to_appointment: 44, appointment_to_attendance: 90, call_to_sale: 50, lead_to_sale: 19, no_show_rate: 15 },
    },
  },
  conversations_started: { data: { value: 52 } },
  conversion_rate: { data: { value: 17.3 } },
  operations_summary: { data: { operations: { inbound_messages: 310, open_conversations: 12, handoffs: 3, average_first_response_minutes: 4, overdue_follow_ups: 7, unassigned_leads: 2 } } },
  open_conversations: { data: { open: 12, ai_open: 8, resolved_today: 25 } },
  whatsapp_connection: { data: { total: 2, connected: 2 } },
  today_agenda: { data: { items: [{ id: 'a1', start_at: '2026-09-29T13:00:00Z', lead_name: 'Lead da Silva' }], period: { timezone: 'America/Sao_Paulo' } } },
  handoffs: { data: { total: 3, items: [{ id: 'h1', contact_name: 'Contato da fila', waiting_minutes: 5 }] } },
  recent_alerts: { data: { items: [{ id: 'al1', message: 'Alerta operacional', created_at: '2026-01-01T10:00:00Z' }] } },
  attendance_rate: { data: { value: 86 } },
  reschedules: { data: { value: 4 } },
  pipeline: { data: { stages: [{ id: 's1', name: 'Novo', count: 12, capacity_target: 20, color: '#22D3EE' }] } },
  new_leads: { data: { value: 33 } },
  pending_follow_ups: { data: { value: 9 } },
  leads_paid_traffic: { data: { value: 20 } },
  leads_referral: { data: { value: 10 } },
  leads_organic: { data: { value: 14 } },
  leads_other_sources: { data: { value: 4 } },
  lost_sales: { data: { value: 3 } },
  sales_paid_traffic: { data: { value: 4 } },
  sales_referral: { data: { value: 2 } },
  sales_organic: { data: { value: 3 } },
  team_load: { data: { members: [{ member_id: 'm1', name: 'Closer Um', availability_status: 'available', completed: 15, no_show: 1, sales: 7, closing_rate: 50, sold_value: 9800 }] } },
}

// Corpo do bundle consolidado: cada widget vira { key, data } com o mesmo
// payload que o endpoint individual devolvia.
const bundleBody = (keys?: string[]) => ({
  widgets: Object.fromEntries(
    Object.entries(endpoints)
      .filter(([key]) => !keys || keys.includes(key))
      .map(([key, body]) => [key, { key, data: (body as { data: unknown }).data }]),
  ),
})

describe('DashboardReferenceOverview', () => {
  it('renderiza hero, funil, conversões e as seções que substituem o board', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/dashboard?include=widgets')) return respond(bundleBody())
      return respond({ data: {} })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <DashboardReferenceOverview periodQuery="period=today" />
      </SWRConfig>,
    )

    // Hero + KPIs + funil (visual de referência, funil definitivo)
    await waitFor(() => expect(screen.getByText(/13\.500,00/)).toBeInTheDocument())
    expect(screen.getByText('52')).toBeInTheDocument()
    expect(screen.getByText('17%')).toBeInTheDocument()
    expect(screen.getByText('44%')).toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getAllByText('50%').length).toBeGreaterThan(0)
    expect(screen.getByText('Funil de conversão')).toBeInTheDocument()
    for (const t of ['21', '9', '19%']) expect(screen.getAllByText(t).length).toBeGreaterThan(0)

    // Atendimento
    expect(screen.getByText('Mensagens recebidas')).toBeInTheDocument()
    expect(screen.getByText('310')).toBeInTheDocument()
    expect(screen.getByText('Conversas abertas (agora)')).toBeInTheDocument()
    expect(screen.getByText('8 com IA · 25 resolvidas hoje')).toBeInTheDocument()
    expect(screen.getByText('4 min')).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()

    // Operação agora: reuniões, agenda, handoffs e alertas
    expect(screen.getByText('Taxa de comparecimento')).toBeInTheDocument()
    expect(screen.getByText('86%')).toBeInTheDocument()
    expect(screen.getByText('Reagendamentos')).toBeInTheDocument()
    expect(screen.getByText('Lead da Silva')).toBeInTheDocument()
    expect(screen.getByText('Contato da fila')).toBeInTheDocument()
    expect(screen.getByText('5 min')).toBeInTheDocument()
    expect(screen.getByText('Alerta operacional')).toBeInTheDocument()

    // Pipeline
    expect(screen.getByText('Pipeline')).toBeInTheDocument()
    expect(screen.getByText('12 / 20')).toBeInTheDocument()

    // Origem dos leads e vendas por origem
    expect(screen.getByText('Origem dos leads')).toBeInTheDocument()
    expect(screen.getByText('33')).toBeInTheDocument()
    expect(screen.getByText('Follow-ups pendentes')).toBeInTheDocument()
    expect(screen.getByText('Vendas por origem')).toBeInTheDocument()
    expect(screen.getByText('Vendas perdidas')).toBeInTheDocument()

    // Equipe
    expect(screen.getByText('Closer Um')).toBeInTheDocument()
    expect(screen.getByText('R$ 9.800,00')).toBeInTheDocument()

    // Uma única request consolidada alimenta todas as seções, com o período.
    expect(calls.filter((url) => url.includes('/dashboard?include=widgets'))).toHaveLength(1)
    expect(calls.some((url) => url.includes('period=today'))).toBe(true)
    expect(calls.some((url) => url.includes('/dashboard/widgets/'))).toBe(false)
  })

  it('com agendamentos desativado, mostra o aviso do funil e mantém as seções de operação', async () => {
    caps.appointments = false;
    caps.leads = false;
    caps.pipeline = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // O servidor inclui no bundle apenas widgets liberados pelo catálogo:
      // com agendamentos desativado, os comerciais não aparecem no payload.
      if (url.includes('/dashboard?include=widgets')) {
        return respond(bundleBody(['operations_summary', 'open_conversations', 'whatsapp_connection', 'handoffs', 'recent_alerts']))
      }
      return forbidden()
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <DashboardReferenceOverview periodQuery="period=today" />
      </SWRConfig>,
    )

    // Aviso do funil no lugar do hero/funil, sem quebrar a página…
    expect(await screen.findByText('Métricas comerciais indisponíveis')).toBeInTheDocument()
    // …e as seções que não dependem de agendamentos continuam na tela.
    expect(await screen.findByText('Mensagens recebidas')).toBeInTheDocument()
    expect(screen.getByText('Handoffs aguardando')).toBeInTheDocument()
    expect(screen.getByText('Alerta operacional')).toBeInTheDocument()
    expect(screen.queryByText('Valor vendido')).not.toBeInTheDocument()
    expect(screen.queryByText('Taxa de comparecimento')).not.toBeInTheDocument()
  })
})
