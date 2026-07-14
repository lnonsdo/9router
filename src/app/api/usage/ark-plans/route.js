// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { getVolcengineArkOpenApiUsage } from "open-sse/services/usage/volcengine-ark-openapi.js";

/**
 * GET /api/usage/ark-plans?connectionId=<id>
 *
 * Returns Volcengine Ark (OpenAPI / AK-SK channel) subscription + AFP usage
 * for the given connection. Used by the dedicated Ark panel on the quota page.
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

    const usage = await getVolcengineArkOpenApiUsage(
      connection,
      connection.providerSpecificData,
      null,
    );

    return Response.json(usage);
  } catch (error) {
    console.error("[ark-plans] error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
