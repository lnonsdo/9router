// Mounts the real fork-only summary strip (react-dom/server, no browser) to
// check what the pure-helper test cannot: that the rendered totals actually
// add up, that unusable packs are named as excluded, and that a provider whose
// windows overlap is never summed into a fake balance.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaSummaryRow from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaSummaryRow.jsx";
import { sortQuotasByExhaustion } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaExhaustion.js";

const NOW = Date.parse("2026-10-29T00:00:00Z");

// One CodeBuddy account: a live refill pack, a nearly-spent pack, a spent pack,
// and a bonus pack whose credits are gone because the pack lapsed.
const CODEBUDDY_ROWS = [
  { name: "Bonus Pack 1", used: 100, total: 100, recurring: false, resetAt: "2026-10-01T00:00:00Z" },
  { name: "Bonus Pack 2", used: 40, total: 60, recurring: false, resetAt: "2026-11-05T00:00:00Z" },
  { name: "Monthly", used: 6.54, total: 500, recurring: true, resetAt: "2026-11-30T00:00:00Z" },
  { name: "Bonus Pack 3", used: 0, total: 100, recurring: false, resetAt: "2026-10-15T00:00:00Z" },
];

const render = (props) => renderToStaticMarkup(createElement(QuotaSummaryRow, props));

const nameOrder = (rows) =>
  sortQuotasByExhaustion(rows, "default", NOW).map((q) => q.name);

describe("quota tracker ordering (as the view applies it)", () => {
  it("sinks the spent and lapsed packs below everything still usable", () => {
    const order = nameOrder(CODEBUDDY_ROWS);
    // Inside the live tier the provider's soonest-expiry-first order is kept,
    // so credits that expire soon are spent before the monthly refill.
    expect(order.slice(0, 2)).toEqual(["Bonus Pack 2", "Monthly"]);
    expect(order.slice(2).sort()).toEqual(["Bonus Pack 1", "Bonus Pack 3"]);
  });

  it("never lets the exhausted-first rule be undone by the sort control", () => {
    expect(nameOrder(CODEBUDDY_ROWS)[0]).toBe(
      sortQuotasByExhaustion(CODEBUDDY_ROWS, "remaining-asc", NOW)[0].name,
    );
    expect(sortQuotasByExhaustion(CODEBUDDY_ROWS, "remaining-desc", NOW).slice(0, 2).map((q) => q.name)).toEqual([
      "Monthly",
      "Bonus Pack 2",
    ]);
  });
});

describe("QuotaSummaryRow", () => {
  it("renders total, consumed and remaining for the live packs only", () => {
    const html = render({ quotas: sortQuotasByExhaustion(CODEBUDDY_ROWS, "default", NOW), now: NOW });

    // Bonus Pack 2 (40/60) + Monthly (6.54/500) are the only live, measurable
    // packs: 560 capacity, 46.54 consumed, 513.46 left (92%).
    expect(html).toContain("Total");
    expect(html).toContain("560");
    expect(html).toContain("Consumed");
    expect(html).toContain("46.54");
    expect(html).toContain("Remaining");
    expect(html).toContain("513.46");
    expect(html).toContain("92%");
    expect(html).toContain("2 depleted");
    // The unspendable lapsed pack is named, not silently dropped from the math.
    expect(html).toContain("expired excluded");
  });

  it("does not promise capacity from a lapsed pack", () => {
    const rows = [
      { name: "Monthly", used: 100, total: 500, recurring: true, resetAt: "2026-11-30T00:00:00Z" },
      // 100 credits sit on it, but the pack expired — they cannot be spent.
      { name: "Bonus Pack 9", used: 0, total: 100, recurring: false, resetAt: "2026-10-15T00:00:00Z" },
    ];
    const html = render({ quotas: rows, now: NOW });
    // Values render inside their own element: ">500<", not a substring of a
    // Tailwind class name like "text-green-600".
    expect(html).toContain(">500<");
    // 600 would mean the lapsed pack's 100 credits were counted as available.
    expect(html).not.toContain(">600<");
    expect(html).toContain(">400 · 80%<");
    expect(html).toContain("1 expired excluded");
  });

  it("renders nothing when there is no measurable capacity", () => {
    expect(render({ quotas: [], now: NOW })).toBe("");
    expect(render({ quotas: [{ name: "Free", used: 3, total: 0, unlimited: true }], now: NOW })).toBe("");
  });

  it("falls back to a percentage when the packs use different units", () => {
    const html = render({
      quotas: [
        { name: "Requests", used: 10, total: 100, unit: "requests" },
        { name: "Credits", used: 5, total: 50, unit: "credits" },
      ],
      now: NOW,
    });
    // 150 combined capacity / 15 used = 90% — but the absolutes are meaningless.
    expect(html).toContain("Remaining overall");
    expect(html).toContain("90%");
    expect(html).toContain("mixed units");
    expect(html).not.toContain(">Total<");
  });

  it("keeps an uncapped row out of both the totals and the depleted count", () => {
    const html = render({
      quotas: [
        { name: "Monthly", used: 100, total: 500, recurring: true, resetAt: "2026-11-30T00:00:00Z" },
        // total 0 paints as "0 / ∞" in the table; calculatePercentage would
        // otherwise read it as 0% remaining and bury it as exhausted.
        { name: "Unmetered", used: 12, total: 0 },
      ],
      now: NOW,
    });
    expect(html).toContain("unlimited ♾ excluded");
    expect(html).not.toContain("depleted");
    expect(html).toContain("400");
  });

  it("reports what the totals exclude without hiding the headline numbers", () => {
    const html = render({
      quotas: [
        { name: "Monthly", used: 0, total: 100, recurring: true, resetAt: "2026-11-30T00:00:00Z" },
        { name: "Wallet", used: 0, total: 25, isCreditBalance: true },
      ],
      now: NOW,
    });
    expect(html).toContain("100");
    expect(html).toContain("credit balance 💰 excluded");
  });

  it("renders a full account as 100% remaining", () => {
    expect(render({ quotas: [{ used: 0, total: 10 }], now: NOW })).toContain("100%");
  });
});
