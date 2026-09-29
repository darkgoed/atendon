// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { DashboardReferenceOverview } from '../components/dashboard-reference-overview'

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('DashboardReferenceOverview', () => {
  it('renders KPIs, funnel and conversions from the three endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('commercial_metrics'))
        return respond({
          data: {
            result: { new_contacts: 48, appointments: 21, calls: 18, sales: 9, sold_value: 13500, average_ticket: 1500, due_meetings: 20, no_show: 3 },
            funnel: { lead_to_appointment: 44, appointment_to_attendance: 90, call_to_sale: 50, lead_to_sale: 19, no_show_rate: 15 },
          },
        })
      if (url.includes('conversations_started')) return respond({ data: { value: 52 } })
      if (url.includes('conversion_rate')) return respond({ data: { value: 17.3 } })
      return respond({ data: {} })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <DashboardReferenceOverview periodQuery="period=today" />
      </SWRConfig>,
    )

    await waitFor(() => expect(screen.getByText(/13\.500,00/)).toBeInTheDocument())
    expect(screen.getByText('48')).toBeInTheDocument()
    expect(screen.getByText('52')).toBeInTheDocument()
    expect(screen.getByText('18')).toBeInTheDocument()
    expect(screen.getByText('17%')).toBeInTheDocument()
    expect(screen.getByText('44%')).toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    for (const t of ['21', '9', '19%']) expect(screen.getAllByText(t).length).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.filter((u) => u.includes('commercial_metrics') && u.includes('period=today'))).toHaveLength(1)
    expect(urls.filter((u) => u.includes('conversations_started'))).toHaveLength(1)
    expect(urls.filter((u) => u.includes('conversion_rate'))).toHaveLength(1)
  })
})
