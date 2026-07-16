// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { callArkOpenApi } from "open-sse/lib/volcengine/signerV4.js";

/**
 * GET /api/usage/ark-billing?connectionId=<id>&month=2026-07
 *
 * Returns Volcengine Ark billing details (按量/抵扣明细) for the given
 * connection via the 管控面 OpenAPI (ListBill). AK/SK come from
 * providerSpecificData so no re-authorization is needed.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const connectionId = searchParams.get("connectionId");
    if (!connectionId) {
      return Response.json({ error: "connectionId is required" }, { status: 400 });
    }

    const connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }
    if (connection.provider !== "volcengine-sso") {
      return Response.json(
        { error: "Connection is not a Volcengine SSO connection" },
        { status: 400 },
      );
    }

    const psd = connection.providerSpecificData || {};
    // Prefer long-lived IAM AK/SK; fall back to the 2-day STS creds from SSO
    const ak = psd.volcIamAk || psd.volcAk;
    const sk = psd.volcIamSk || psd.volcSk;
    if (!ak || !sk) {
      return Response.json(
        { message: "未配置火山方舟密钥，无法查询账单。请绑定长效 IAM AK/SK 或先完成 SSO 登录。" },
        { status: 200 },
      );
    }


    // const month = searchParams.get("month") || "";
    // Volcengine billing uses "BillPeriod" (YYYY-MM) as the required param.
    const month = searchParams.get("month") || new Date().toISOString().substring(0, 7);
    const payload = { BillPeriod: month, Limit: 10, Product: ['ark'] };

    let data;
    try {
      data = await callArkOpenApi({
        ak,
        sk,
        action: "ListBill",
        version: "2022-01-01",
        payload,
        baseUrl: "https://billing.volcengineapi.com",
        service: "billing",
        region: "cn-beijing",
      });
    } catch (err) {
      // AccessDenied => AK/SK lacks billing:ListBill; guide the user to grant it.
      const isPerm = /AccessDenied|Forbidden/i.test(err.message);
      return Response.json(
        {
          message: isPerm
            ? "账单查询需要 AK/SK 具备费用中心只读权限（billing:ListBill）。请在 IAM 为当前密钥授权后重试。"
            : `账单查询失败：${err.message}`,
        },
        { status: 200 },
      );
    }

    const result = data?.Result || {};
    return Response.json({
      bills: result.List || [],
      total: result.Total || 0,
      raw: data,
    });
  } catch (error) {
    console.error("[ark-billing] error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
