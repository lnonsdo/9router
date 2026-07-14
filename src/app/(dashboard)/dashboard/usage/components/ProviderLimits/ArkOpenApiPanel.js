"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Volcengine Ark OpenAPI panel, rendered inside an EXISTING `volcengine-sso`
 * connection card on the quota page — but ONLY when a long-lived IAM AK/SK is
 * bound (volcIamAk). Binding happens on the SSO connection's edit page.
 *
 * Tier-level quota detail (AFP / Coding plan session-week-month) is NOT shown
 * here — it is served through the main QuotaTable via the ark-cli → OpenAPI
 * fallback in getVolcengineArkUsage, so it shares the same row format as the
 * ark-cli data. This panel only shows the OpenAPI-exclusive bits:
 *   - 套餐订阅 (Agent/Coding plan type, days remaining)
 *   - 账单明细  (ListBill, requires billing:ListBill permission)
 */
export default function ArkOpenApiPanel({ connection }) {
  const connectionId = connection.id;
  const psd = connection.providerSpecificData || {};
  // volcIamSk is intentionally NOT returned to the client; presence of the AK
  // is sufficient to know a long-lived key is bound.
  const hasIam = Boolean(psd.volcIamAk);

  const [plans, setPlans] = useState(null);
  const [billing, setBilling] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [plansRes, billingRes] = await Promise.all([
        fetch(`/api/usage/ark-plans?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store" }),
        fetch(`/api/usage/ark-billing?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store" }),
      ]);
      setPlans(plansRes.ok ? await plansRes.json() : { message: "套餐查询失败" });
      setBilling(billingRes.ok ? await billingRes.json() : { message: "账单查询失败" });
    } catch (err) {
      setError(err.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    load();
  }, [load]);

  // Only show when a long-lived IAM key is bound (per product decision).
  if (!hasIam) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
        <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
        正在查询火山方舟套餐与账单…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>
    );
  }

  const planQuotas = plans?.quotas ? Object.values(plans.quotas) : [];
  const planMessage = plans?.message || null;
  // Tier-level detail entries (Coding Plan session/weekly/monthly)
  const subEntries = planQuotas.filter((q) => !q.meta?.isTier);

  return (
    <div className="space-y-4 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">
          OpenAPI (长效 IAM)
        </span>
        {plans?.accountId ? <span className="text-[10px] text-text-muted">账号 {plans.accountId}</span> : null}
        <button
          type="button"
          onClick={load}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
          aria-label="刷新"
        >
          <span className="material-symbols-outlined text-[15px]">refresh</span>
        </button>
      </div>

      {/* 套餐订阅 */}
      <section>
        <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <span className="material-symbols-outlined text-[15px] text-primary">card_membership</span>
          套餐订阅
        </h4>
        {planMessage && !subEntries.length ? (
          <p className="text-xs text-text-muted">{planMessage}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {subEntries.map((q) => {
              const m = q.meta || {};
              const expired = m.status === "Expired";
              return (
                <div key={q.name} className="rounded-lg border border-black/10 p-2.5 dark:border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-text-primary">{q.name}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                        expired
                          ? "bg-red-500/10 text-red-600 dark:text-red-400"
                          : "bg-green-500/10 text-green-600 dark:text-green-400"
                      }`}
                    >
                      {expired ? "已过期" : m.status === "Running" ? "生效中" : m.status || "—"}
                    </span>
                  </div>
                  {!expired && (
                    <div className="mt-2">
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-text-muted">剩余</span>
                        <span className="font-semibold tabular-nums text-text-primary">{q.remaining} 天</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(0, Math.min(100, q.remainingPercentage))}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {m.endTime ? (
                    <p className="mt-1.5 text-[10px] text-text-muted">到期：{new Date(m.endTime).toLocaleString("zh-CN")}</p>
                  ) : null}
                  <p className="mt-0.5 text-[10px] text-text-muted">自动续费：{m.autoRenew ? "已开启" : "未开启"}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 账单明细 */}
      <section>
        <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <span className="material-symbols-outlined text-[15px] text-primary">receipt_long</span>
          账单明细
          {billing?.total ? <span className="text-[10px] font-normal text-text-muted">共 {billing.total} 笔</span> : null}
        </h4>
        {billing?.message ? (
          <p className="text-xs text-text-muted">{billing.message}</p>
        ) : billing?.bills?.length ? (
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
            <table className="w-full min-w-[420px] text-left text-xs">
              <thead className="bg-black/[0.03] text-text-muted dark:bg-white/[0.04]">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">账期</th>
                  <th className="px-2.5 py-1.5 font-medium">产品</th>
                  <th className="px-2.5 py-1.5 font-medium">应付</th>
                  <th className="px-2.5 py-1.5 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {billing.bills.slice(0, 12).map((b, i) => (
                  <tr key={b.BillID || i} className="border-t border-black/5 dark:border-white/5">
                    <td className="px-2.5 py-1.5 tabular-nums text-text-primary">{b.BillPeriod || "—"}</td>
                    <td className="px-2.5 py-1.5 text-text-primary">{b.ProductZh || b.Product || "—"}</td>
                    <td className="px-2.5 py-1.5 tabular-nums text-text-primary">
                      {b.PayableAmount ?? "—"} {b.Currency || ""}
                    </td>
                    <td className="px-2.5 py-1.5 text-text-muted">{b.PayStatus || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-text-muted">暂无账单数据。</p>
        )}
      </section>
    </div>
  );
}
