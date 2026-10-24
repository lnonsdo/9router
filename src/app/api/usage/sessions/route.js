import { NextResponse } from "next/server";
import { getSessionStats } from "@/lib/usageDb";

/**
 * GET /api/usage/sessions
 * Aggregate token/cost usage grouped by conversation session.
 * Query parameters: connectionId, startDate, endDate
 *   sessionId / unclassified=1 — fetch a single session (used by the session
 *     drawer to lazy-load per-model stats); responds with { session }.
 *   includeModelStats=false — omit per-model breakdown from every row
 *     (the sessions list uses this to keep the payload small).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const connectionId = searchParams.get("connectionId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const sessionId = searchParams.get("sessionId");
    const unclassified = searchParams.get("unclassified") === "1";
    const includeModelStats = searchParams.get("includeModelStats") !== "false";

    const filter = {};
    if (connectionId) filter.connectionId = connectionId;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (sessionId) filter.sessionId = sessionId;
    if (unclassified) filter.unclassified = true;

    const result = await getSessionStats(filter, { includeModelStats });

    if (sessionId || unclassified) {
      return NextResponse.json({ session: result.sessions[0] || null });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API ERROR] /api/usage/sessions failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch session stats" }, { status: 500 });
  }
}
