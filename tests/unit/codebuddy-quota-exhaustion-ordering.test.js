// CodeBuddy CN reports one recurring refill pack plus several one-shot bonus
// packs, most of them already used up. The usage handler hands them back sorted
// by cycle end (soonest first), so an exhausted or expired bonus pack used to
// sit ABOVE the pack that still works. The tracker must instead rank by how much
// is left, sink the exhausted rows, and show a self-computed roll-up.
import { describe, it, expect } from "vitest";
import {
  parseQuotaData,
  getRemainingPercentage,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import {
  sortQuotasByExhaustion,
  summarizeQuotas,
  getQuotaTier,
  isDepletedQuota,
  isExpiredQuota,
  isUncappedQuota,
  hasUsableQuota,
  isAdditiveQuotaProvider,
  QUOTA_TIER,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaExhaustion.js";

const names = (rows) => rows.map((q) => q.name);

describe("getQuotaTier / isDepletedQuota", () => {
  it("classifies a fully consumed pack as depleted", () => {
    expect(getQuotaTier({ name: "Bonus Pack 1", used: 100, total: 100 })).toBe(
      QUOTA_TIER.DEPLETED,
    );
    expect(isDepletedQuota({ used: 500, total: 500 })).toBe(true);
  });

  it("keeps unlimited and credit-balance rows out of the depleted tier", () => {
    expect(getQuotaTier({ used: 10, total: 0, unlimited: true })).toBe(QUOTA_TIER.UNLIMITED);
    expect(getQuotaTier({ used: 3, total: 50, isCreditBalance: true })).toBe(QUOTA_TIER.BALANCE);
  });

  it("treats an unknown/infinite total as uncapped, not exhausted", () => {
    // calculatePercentage(used, 0) returns 0; without this guard an "∞" row
    // would be sunk to the bottom as if it were used up — or worse, lead the
    // list as "most critical". It reports no cap, so it is not a constraint.
    expect(isDepletedQuota({ name: "Unmetered", used: 12, total: 0 })).toBe(false);
    expect(isUncappedQuota({ name: "Unmetered", used: 12, total: 0 })).toBe(true);
    expect(getQuotaTier({ name: "Unmetered", used: 12, total: 0 })).toBe(QUOTA_TIER.UNLIMITED);
  });

  it("honours an explicit percentage signal even without a finite total", () => {
    expect(getQuotaTier({ remainingPercentage: 0, total: 0 })).toBe(QUOTA_TIER.DEPLETED);
    expect(getQuotaTier({ remainingPercentage: 40, total: 0 })).toBe(QUOTA_TIER.ACTIVE);
  });

  it("reads a provider-reported used share (percentageIsUsed)", () => {
    expect(getQuotaTier({ percentage: 100, percentageIsUsed: true, total: 10 })).toBe(
      QUOTA_TIER.DEPLETED,
    );
  });
});

describe("sortQuotasByExhaustion", () => {
  // Exactly what CodeBuddy returns: an expired bonus pack first, then a nearly
  // spent one, then the live monthly refill.
  const codebuddyRows = [
    { name: "Bonus Pack 1", used: 100, total: 100, recurring: false },
    { name: "Bonus Pack 2", used: 88, total: 100, recurring: false },
    { name: "Monthly", used: 6.54, total: 500, recurring: true },
  ];

  it("sinks exhausted packs below everything still usable", () => {
    // Bonus Pack 1 (0%) drops out of the head of the list; the two live packs
    // keep the provider's soonest-expiry-first order, which is the point —
    // bonus credits expire, so spending them first is correct.
    expect(names(sortQuotasByExhaustion(codebuddyRows, "default"))).toEqual([
      "Bonus Pack 2",
      "Monthly",
      "Bonus Pack 1",
    ]);
  });

  it("keeps exhaustion as the primary key regardless of sortMode", () => {
    // remaining-asc must not promote the 0% pack back to the top, and
    // remaining-desc must not pull it up ahead of a live pack either.
    expect(names(sortQuotasByExhaustion(codebuddyRows, "remaining-asc"))).toEqual([
      "Bonus Pack 2",
      "Monthly",
      "Bonus Pack 1",
    ]);
    expect(names(sortQuotasByExhaustion(codebuddyRows, "remaining-desc"))).toEqual([
      "Monthly",
      "Bonus Pack 2",
      "Bonus Pack 1",
    ]);
  });

  it("orders live rows by remaining share when asked", () => {
    const rows = [
      { name: "Weekly", used: 60, total: 100 },
      { name: "Monthly", used: 5, total: 100 },
      { name: "Spent", used: 100, total: 100 },
    ];
    expect(names(sortQuotasByExhaustion(rows, "remaining-asc"))).toEqual([
      "Weekly",
      "Monthly",
      "Spent",
    ]);
    expect(names(sortQuotasByExhaustion(rows, "remaining-desc"))).toEqual([
      "Monthly",
      "Weekly",
      "Spent",
    ]);
  });

  it("preserves provider order inside the default mode (stable)", () => {
    const rows = [
      { name: "A", used: 50, total: 100 },
      { name: "B", used: 50, total: 100 },
      { name: "C", used: 50, total: 100 },
    ];
    expect(names(sortQuotasByExhaustion(rows, "default"))).toEqual(["A", "B", "C"]);
  });

  it("keeps a nearly-empty pack live even though it displays as 0%", () => {
    // getRemainingPercentage(499, 500) ROUNDS to 0. Exhaustion must compare the
    // raw amounts, or a pack with credit left would sink as if it were spent.
    expect(getRemainingPercentage({ used: 499, total: 500 })).toBe(0);
    expect(isDepletedQuota({ used: 499, total: 500 })).toBe(false);
    expect(isDepletedQuota({ used: 500, total: 500 })).toBe(true);
    expect(getQuotaTier({ used: 0.01, total: 500 })).toBe(QUOTA_TIER.ACTIVE);
  });

  it("does not sink a pack whose usage is unknown", () => {
    expect(isDepletedQuota({ total: 100 })).toBe(false);
    expect(getQuotaTier({ total: 100 })).toBe(QUOTA_TIER.ACTIVE);
  });

  it("places unlimited and balance rows above the depleted tail", () => {
    const rows = [
      { name: "Spent", used: 9, total: 9 },
      { name: "Free tier", used: 1, total: 0, unlimited: true },
      { name: "Live", used: 1, total: 100 },
    ];
    expect(names(sortQuotasByExhaustion(rows, "default"))).toEqual(["Live", "Free tier", "Spent"]);
  });

  it("does not mutate the input array", () => {
    const rows = [
      { name: "Spent", used: 10, total: 10 },
      { name: "Live", used: 1, total: 10 },
    ];
    sortQuotasByExhaustion(rows, "default");
    expect(names(rows)).toEqual(["Spent", "Live"]);
  });

  it("tolerates empty and non-array input", () => {
    expect(sortQuotasByExhaustion(undefined, "default")).toEqual([]);
    expect(sortQuotasByExhaustion([], "default")).toEqual([]);
  });

  it("applies after parseQuotaData so the tracker's real rows are re-ranked", () => {
    const parsed = parseQuotaData("codebuddy-cn", {
      quotas: {
        // Object key order mirrors the handler's soonest-expiry-first output.
        "Bonus Pack 1": { used: 100, total: 100, resetAt: null, recurring: false },
        "Bonus Pack 2": { used: 100, total: 100, resetAt: null, recurring: false },
        Monthly: { used: 480, total: 500, resetAt: null, recurring: true },
      },
    });
    expect(names(sortQuotasByExhaustion(parsed, "default"))).toEqual([
      "Monthly",
      "Bonus Pack 1",
      "Bonus Pack 2",
    ]);
  });
});

describe("summarizeQuotas", () => {
  it("rolls a connection's packs into total / consumed / remaining", () => {
    const summary = summarizeQuotas([
      { name: "Monthly", used: 6.54, total: 500 },
      { name: "Bonus Pack 1", used: 100, total: 100 },
      { name: "Bonus Pack 2", used: 25, total: 150 },
    ]);

    expect(summary.total).toBe(750);
    expect(summary.used).toBeCloseTo(131.54, 2);
    expect(summary.remaining).toBeCloseTo(618.46, 2);
    expect(summary.remainingPercentage).toBe(82);
    expect(summary.counted).toBe(3);
    expect(summary.depleted).toBe(1);
    expect(summary.hasData).toBe(true);
    expect(summary.mixedUnits).toBe(false);
  });

  it("excludes unlimited and credit-balance rows from the absolutes", () => {
    const summary = summarizeQuotas([
      { name: "Monthly", used: 40, total: 100 },
      { name: "Unlimited", used: 999, total: 0, unlimited: true },
      { name: "Wallet", used: 0, total: 25, isCreditBalance: true },
    ]);

    expect(summary.total).toBe(100);
    expect(summary.used).toBe(40);
    expect(summary.remaining).toBe(60);
    expect(summary.unlimited).toBe(1);
    expect(summary.balances).toBe(1);
    expect(summary.counted).toBe(1);
    expect(summary.rowCount).toBe(3);
  });

  it("flags mixed units so the UI can refuse to add unlike quantities", () => {
    const summary = summarizeQuotas([
      { name: "Requests", used: 10, total: 100, unit: "requests" },
      { name: "Credits", used: 5, total: 50, unit: "credits" },
    ]);

    expect(summary.mixedUnits).toBe(true);
    expect(summary.units.sort()).toEqual(["credits", "requests"]);
    // The unit-free share stays meaningful: 150 combined capacity, 15 consumed.
    expect(summary.remainingPercentage).toBe(90);
  });

  it("reports no data when nothing is measurable", () => {
    expect(summarizeQuotas([]).hasData).toBe(false);
    expect(summarizeQuotas([{ unlimited: true }]).hasData).toBe(false);
    expect(summarizeQuotas(undefined).hasData).toBe(false);
  });

  it("ignores negative usage instead of overstating the remainder", () => {
    const summary = summarizeQuotas([{ used: -5, total: 10 }]);
    expect(summary.used).toBe(0);
    expect(summary.remaining).toBe(10);
    expect(summary.remainingPercentage).toBe(100);
  });

  it("keeps a fully-used account at zero remaining", () => {
    const summary = summarizeQuotas([
      { used: 100, total: 100 },
      { used: 50, total: 50 },
    ]);
    expect(summary.remaining).toBe(0);
    expect(summary.remainingPercentage).toBe(0);
    expect(summary.depleted).toBe(2);
  });
});

describe("isExpiredQuota (lapsed one-shot packs)", () => {
  const NOW = Date.parse("2026-10-29T00:00:00Z");

  it("treats a spent-but-not-empty bonus pack past its expiry as exhausted", () => {
    // CodeBuddy bonus packs are one-shot: resetAt is a hard expiry, so 0/100
    // credits left after that date is unspendable, not headroom.
    const lapsed = {
      name: "Bonus Pack 3",
      used: 0,
      total: 100,
      recurring: false,
      resetAt: "2026-10-01T00:00:00Z",
    };
    expect(isExpiredQuota(lapsed, NOW)).toBe(true);
    expect(getQuotaTier(lapsed, NOW)).toBe(QUOTA_TIER.DEPLETED);
  });

  it("keeps a live bonus pack and a refill pack in the active tier", () => {
    expect(
      isExpiredQuota(
        { used: 0, total: 100, recurring: false, resetAt: "2026-11-01T00:00:00Z" },
        NOW,
      ),
    ).toBe(false);
    // A refill pack's resetAt is the NEXT refresh, so being past it means nothing.
    expect(
      isExpiredQuota(
        { used: 0, total: 100, recurring: true, resetAt: "2026-10-01T00:00:00Z" },
        NOW,
      ),
    ).toBe(false);
    // Providers that never emit `recurring` are inert here.
    expect(isExpiredQuota({ used: 0, total: 100, resetAt: "2020-01-01T00:00:00Z" }, NOW)).toBe(false);
  });

  it("sinks a lapsed pack below a pack that is merely nearly spent", () => {
    const rows = [
      { name: "Bonus Pack 3", used: 0, total: 100, recurring: false, resetAt: "2026-10-01T00:00:00Z" },
      { name: "Monthly", used: 499, total: 500, recurring: true, resetAt: "2026-11-30T00:00:00Z" },
    ];
    expect(names(sortQuotasByExhaustion(rows, "default", NOW))).toEqual([
      "Monthly",
      "Bonus Pack 3",
    ]);
  });

  it("excludes lapsed credits so the summary does not promise unspendable capacity", () => {
    const rows = [
      { name: "Monthly", used: 100, total: 500, recurring: true, resetAt: "2026-11-30T00:00:00Z" },
      { name: "Bonus Pack 3", used: 0, total: 100, recurring: false, resetAt: "2026-10-01T00:00:00Z" },
    ];
    const summary = summarizeQuotas(rows, NOW);

    // Only the live pack is summed: 500 total, 100 used, 400 remaining.
    expect(summary.total).toBe(500);
    expect(summary.remaining).toBe(400);
    expect(summary.counted).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.depleted).toBe(1);
    expect(summary.nextResetAt).toBe("2026-11-30T00:00:00.000Z");
  });
});

describe("hasUsableQuota / isAdditiveQuotaProvider", () => {
  it("marks an all-exhausted connection as unusable", () => {
    expect(
      hasUsableQuota([
        { used: 10, total: 10 },
        { used: 1, total: 1 },
      ]),
    ).toBe(false);
    expect(hasUsableQuota([{ used: 10, total: 10 }, { used: 1, total: 9 }])).toBe(true);
    expect(hasUsableQuota([{ used: 10, total: 10 }, { unlimited: true }])).toBe(true);
    expect(hasUsableQuota([])).toBe(false);
  });

  it("aggregates only the providers whose packs are independent and like-for-like", () => {
    expect(isAdditiveQuotaProvider("codebuddy-cn")).toBe(true);
    expect(isAdditiveQuotaProvider("CODEBUDDY-INTL")).toBe(true);
    // Overlapping 5h/weekly windows describe the SAME allowance: summing double-counts.
    expect(isAdditiveQuotaProvider("claude")).toBe(false);
    expect(isAdditiveQuotaProvider("codex")).toBe(false);
    expect(isAdditiveQuotaProvider(undefined)).toBe(false);
  });
});
