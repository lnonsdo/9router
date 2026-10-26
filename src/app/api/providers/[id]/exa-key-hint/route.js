import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";

/**
 * Fork-only helper for the desktop Exa sync window.
 *
 * Exa's dashboard identifies keys by `bearerPrefix` (the first 6 characters),
 * so the injected sync script can verify that the Exa account logged into the
 * window actually owns the key behind the connection being synced. Only the
 * prefix is returned — never the key itself — and it is already visible in the
 * Exa dashboard.
 */
export async function GET(_request, { params }) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);

  if (!connection || connection.provider !== "exa") {
    return NextResponse.json({ prefix: null });
  }

  const apiKey = typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
  return NextResponse.json({ prefix: apiKey ? apiKey.slice(0, 6) : null });
}
