import { NextResponse } from "next/server";
import { getSessionStats } from "@/lib/usageDb";

/**
 * GET /api/usage/sessions
 * Aggregate token/cost usage grouped by conversation session (default) or connection.
 * Query parameters: connectionId, startDate, endDate, groupBy ("session" | "connection")
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const connectionId = searchParams.get("connectionId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const groupBy = searchParams.get("groupBy");

    const filter = {};
    if (connectionId) filter.connectionId = connectionId;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (groupBy === "session" || groupBy === "connection") filter.groupBy = groupBy;

    const result = await getSessionStats(filter);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API ERROR] /api/usage/sessions failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch session stats" }, { status: 500 });
  }
}
