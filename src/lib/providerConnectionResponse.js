import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;
  if (!connection.providerSpecificData) return safe;

  // Credentials stored inside providerSpecificData never round-trip to the
  // browser: the edit form only writes them, it never reads them back.
  const secretFields = usesAwsCredentialForm(connection.provider)
    ? ["sessionToken"]
    : connection.provider === "open-design"
      ? ["amrSessionCookie", "amrControlKey"]
      : [];
  if (secretFields.length === 0) return safe;

  const providerSpecificData = { ...connection.providerSpecificData };
  for (const field of secretFields) delete providerSpecificData[field];
  return { ...safe, providerSpecificData };
}
