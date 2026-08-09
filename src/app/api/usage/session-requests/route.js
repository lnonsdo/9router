import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";

/**
 * GET /api/usage/session-requests
 * Request details for a single session (used by the Trace tab drill-down).
 * Query parameters: sessionId (required), page, pageSize
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const sessionId = searchParams.get("sessionId");
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    const page = parseInt(searchParams.get("page")) || 1;
    const pageSize = Math.min(parseInt(searchParams.get("pageSize")) || 50, 100);

    const result = await getRequestDetails({ sessionId, page, pageSize });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API ERROR] /api/usage/session-requests failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch session requests" }, { status: 500 });
  }
}
