import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";

/**
 * GET /api/usage/session-requests
 * Request details for a single session OR a single connection (used by the Trace
 * tab drill-down). In session view pass sessionId; in connection view pass
 * connectionId to collapse per-request session fragmentation.
 * Query parameters: sessionId | connectionId (one required), page, pageSize
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const sessionId = searchParams.get("sessionId");
    const connectionId = searchParams.get("connectionId");
    if (!sessionId && !connectionId) {
      return NextResponse.json({ error: "sessionId or connectionId is required" }, { status: 400 });
    }

    const page = parseInt(searchParams.get("page")) || 1;
    const pageSize = Math.min(parseInt(searchParams.get("pageSize")) || 50, 100);

    const filter = { page, pageSize };
    if (connectionId) filter.connectionId = connectionId;
    else filter.sessionId = sessionId;

    const result = await getRequestDetails(filter);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API ERROR] /api/usage/session-requests failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch session requests" }, { status: 500 });
  }
}
