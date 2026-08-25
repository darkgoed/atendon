import { describe, expect, it } from "vitest";
import {
  adaptivePollingDelay,
  alertHistoryPollingDelay,
  notificationBadgeLabel,
  toastableAlerts
} from "../lib/alerts";

describe("toastableAlerts", () => {
  it("announces only alerts claimed for this polling response", () => {
    expect(toastableAlerts([
      { id: "new", message: "Falha nova", should_toast: true },
      { id: "historical", message: "Falha já anunciada", should_toast: false }
    ])).toEqual([{ id: "new", message: "Falha nova", should_toast: true }]);
  });

  it("pauses polling while hidden and resumes at the base delay", () => {
    expect(adaptivePollingDelay({
      failures: 0,
      visibilityState: "hidden",
      baseMs: 5_000,
      random: () => 0.5
    })).toBeNull();
    expect(adaptivePollingDelay({
      failures: 0,
      visibilityState: "visible",
      baseMs: 5_000,
      random: () => 0.5
    })).toBe(5_000);
  });

  it("backs off exponentially with bounded jitter after errors", () => {
    expect(adaptivePollingDelay({
      failures: 1,
      visibilityState: "visible",
      baseMs: 5_000,
      random: () => 0.5
    })).toBe(10_000);
    expect(adaptivePollingDelay({
      failures: 3,
      visibilityState: "visible",
      baseMs: 5_000,
      random: () => 0
    })).toBe(32_000);
    expect(adaptivePollingDelay({
      failures: 30,
      visibilityState: "visible",
      baseMs: 5_000,
      maxMs: 60_000,
      random: () => 1
    })).toBe(60_000);
  });

  it("keeps fallback polling within the alert delivery SLO and pauses while hidden", () => {
    expect(alertHistoryPollingDelay({
      deliveryV2: false,
      failures: 8,
      visibilityState: "visible",
      random: () => 1
    })).toBe(10_000);
    expect(alertHistoryPollingDelay({
      deliveryV2: true,
      failures: 2,
      visibilityState: "visible",
      random: () => 0.5
    })).toBe(10_000);
    expect(alertHistoryPollingDelay({
      deliveryV2: false,
      failures: 0,
      visibilityState: "hidden"
    })).toBeNull();
  });

  it("formats the global notification badge without overflowing the trigger", () => {
    expect(notificationBadgeLabel(0)).toBeNull();
    expect(notificationBadgeLabel(-3)).toBeNull();
    expect(notificationBadgeLabel(Number.NaN)).toBeNull();
    expect(notificationBadgeLabel(7)).toBe("7");
    expect(notificationBadgeLabel(99)).toBe("99");
    expect(notificationBadgeLabel(100)).toBe("99+");
  });
});
