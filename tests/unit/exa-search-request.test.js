import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";

const provider = REGISTRY.find((entry) => entry.id === "exa");

describe("Exa search request", () => {
  it("asks for content under `contents`, not the ignored legacy top-level flags", () => {
    const request = buildSearchRequest({ id: "exa", ...provider.searchConfig }, {
      query: "latest release", token: "secret", maxResults: 8,
      domainFilter: ["example.com", "-other.com"],
    });
    const body = JSON.parse(request.init.body);

    // Exa silently ignores top-level text/highlights; the result then carries
    // id/title/url only and the adapter injects no snippets at all.
    expect(body.contents).toEqual({
      text: { maxCharacters: 4000 },
      highlights: { numSentences: 2 },
    });
    expect(body.text).toBeUndefined();
    expect(body.highlights).toBeUndefined();
    expect(body.numResults).toBe(8);
    expect(body.includeDomains).toEqual(["example.com"]);
    expect(body.excludeDomains).toEqual(["other.com"]);
    expect(request.init.headers["x-api-key"]).toBe("secret");
  });
});
