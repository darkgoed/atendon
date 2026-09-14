// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { AgendaHeader } from "@/app/agenda/agenda-header";
import { CommercialDashboard, type CommercialDashboardData } from "@/components/commercial-dashboard";
import { PostSalesSummaryStrip } from "@/components/post-sales-summary";
import { Table, TableScroll } from "@/components/ui";

describe("semantic accessibility regressions", () => {
  it("keeps agenda route heading plain while retaining the visual code outside h1", () => {
    render(<AgendaHeader canCreate canBlock unit="unit-1" mode="day" view="all" pendingCount={0} onCreate={() => undefined} onBlock={() => undefined} onMode={() => undefined} onView={() => undefined} />);
    expect(screen.getByRole("heading", { level: 1, name: "Agenda" })).toBeInTheDocument();
    expect(screen.getByText("AG—01")).not.toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("makes summary and table scroll wrappers named, focusable regions", () => {
    render(<><PostSalesSummaryStrip summary={{ active: 2, archived: 1, not_started: 0, in_progress: 1, complete: 3, overdue: 1, today: 1, upcoming: 2 }} /><TableScroll role="region" aria-label="Audit log"><table><tbody><tr><td>Entry</td></tr></tbody></table></TableScroll><Table aria-label="Members"><tbody><tr><td>Member</td></tr></tbody></Table></>);
    expect(screen.getByRole("region", { name: "Resumo da carteira" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Audit log" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("table", { name: "Members" }).parentElement).toHaveAttribute("tabindex", "0");
  });

  it("renders dashboard metric terms inside their description-list parent", () => {
    const zeros = { created: 0, scheduled: 1, completed: 1, no_show: 0, cancelled: 0, upcoming: 0, overdue: 0, result_pending: 0, rescheduled: 0, proposals: 0, negotiations: 0, sales: 0, closing_rate: 0, sold_value: 0, average_ticket: 0, overdue_follow_ups: 0, attendance_rate: 0, no_show_rate: 0, average_quality: null };
    const data = { scope: { type: "mine", member_id: "member-1", email: "member@example.com", is_closer: true, is_attendant: true, availability_status: "available" }, period: { key: "today", start: "2026-01-01", end: "2026-01-01", timezone: "UTC" }, metrics: zeros, sdr_metrics: { received: 0, attended: 0, qualified: 0, scheduled: 0, qualification_rate: 0, scheduling_rate: 0, average_first_response_minutes: null, overdue_follow_ups: 0, recovered_no_shows: 0 }, commercial_metrics: { scheduled: 0, completed: 0, attended: 0, no_show: 0, rescheduled: 0, cancelled: 0, result_pending: 0, proposals: 0, negotiations: 0, sales: 0, attendance_rate: 0, closing_rate: 0, sold_value: 0, average_ticket: 0, overdue_follow_ups: 0 }, series: [{ day: "2026-01-01", scheduled: 1, completed: 1, no_show: 0, cancelled: 0 }], today_agenda: [], team: [] } as CommercialDashboardData;
    render(<CommercialDashboard data={data} selectedPeriod="today" customStart="" customEnd="" onPeriodChange={() => undefined} onCustomStartChange={() => undefined} onCustomEndChange={() => undefined} />);
    const metricStrip = screen.getAllByText("Marcadas")[0].closest("dl");
    expect(metricStrip).toBeInTheDocument();
    expect(metricStrip?.querySelectorAll(":scope > div > dt")).toHaveLength(5);
  });

  it("preserves table wrapper ref and caller attributes", () => {
    const ref = createRef<HTMLDivElement>();
    render(<TableScroll ref={ref} role="region" aria-label="Scrollable records" data-testid="records"><span>Records</span></TableScroll>);
    const wrapper = screen.getByTestId("records");
    expect(ref.current).toBe(wrapper);
    expect(wrapper).toHaveAttribute("role", "region");
    expect(wrapper).toHaveAttribute("aria-label", "Scrollable records");
    expect(wrapper).toHaveAttribute("tabindex", "0");
  });
});
