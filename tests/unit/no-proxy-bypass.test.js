import { describe, it, expect } from "vitest";

import { shouldBypassByNoProxy } from "../../open-sse/utils/proxyFetch.js";

describe("shouldBypassByNoProxy", () => {
  describe("IPv4 CIDR", () => {
    it("matches targets inside the range", () => {
      expect(shouldBypassByNoProxy("http://192.168.1.10:8080/api", "192.168.0.0/16")).toBe(true);
      expect(shouldBypassByNoProxy("http://10.255.1.1/", "10.0.0.0/8")).toBe(true);
      expect(shouldBypassByNoProxy("http://172.31.255.255/", "172.16.0.0/12")).toBe(true);
    });

    it("rejects targets outside the range", () => {
      expect(shouldBypassByNoProxy("http://192.169.0.1/", "192.168.0.0/16")).toBe(false);
      expect(shouldBypassByNoProxy("http://11.0.0.1/", "10.0.0.0/8")).toBe(false);
      expect(shouldBypassByNoProxy("http://172.32.0.1/", "172.16.0.0/12")).toBe(false);
    });

    it("honors non-octet-aligned prefixes", () => {
      expect(shouldBypassByNoProxy("http://100.64.1.1/", "100.64.0.0/10")).toBe(true);
      expect(shouldBypassByNoProxy("http://100.127.255.254/", "100.64.0.0/10")).toBe(true);
      expect(shouldBypassByNoProxy("http://100.128.0.1/", "100.64.0.0/10")).toBe(false);
    });
  });

  describe("IPv6", () => {
    it("matches CIDR ranges against bracketed hosts", () => {
      expect(shouldBypassByNoProxy("http://[fd12::1]:3000/", "fd00::/7")).toBe(true);
      expect(shouldBypassByNoProxy("http://[fc00::1]/", "fd00::/7")).toBe(true);
      expect(shouldBypassByNoProxy("http://[fe80::1]/", "fe80::/10")).toBe(true);
    });

    it("rejects out-of-range or family-mismatched hosts", () => {
      expect(shouldBypassByNoProxy("http://[fe80::1]/", "fd00::/7")).toBe(false);
      expect(shouldBypassByNoProxy("http://[fec0::1]/", "fe80::/10")).toBe(false);
      expect(shouldBypassByNoProxy("http://[2001:db8::1]/", "fd00::/7")).toBe(false);
      // v4-mapped v6 is a different family than a v4 range (curl-consistent)
      expect(shouldBypassByNoProxy("http://[::ffff:192.168.1.1]/", "192.168.0.0/16")).toBe(false);
    });

    it("matches bare ::1 patterns against [::1] hosts", () => {
      expect(
        shouldBypassByNoProxy("http://[::1]:3000/", "localhost,127.0.0.1,::1")
      ).toBe(true);
      expect(shouldBypassByNoProxy("http://[::1]/", "::1/128")).toBe(true);
      expect(shouldBypassByNoProxy("http://[::2]/", "::1/128")).toBe(false);
    });
  });

  describe("hostnames", () => {
    it("never resolves hostnames for CIDR patterns", () => {
      expect(shouldBypassByNoProxy("http://nas.internal/", "10.0.0.0/8")).toBe(false);
    });

    it("keeps suffix, exact and wildcard behavior", () => {
      expect(shouldBypassByNoProxy("http://nas.local/", ".local")).toBe(true);
      expect(shouldBypassByNoProxy("http://nas.local/", "local")).toBe(true);
      expect(shouldBypassByNoProxy("http://api.example.com/", "example.com")).toBe(true);
      expect(shouldBypassByNoProxy("http://api.example.com/", "badexample.com")).toBe(false);
      expect(shouldBypassByNoProxy("http://anything.example/", "*")).toBe(true);
      expect(shouldBypassByNoProxy("http://example.com/", "example.com")).toBe(true);
    });
  });

  describe("malformed patterns", () => {
    it("ignore bad CIDR entries without throwing", () => {
      expect(shouldBypassByNoProxy("http://10.1.1.1/", "10.0.0.0/33")).toBe(false);
      expect(shouldBypassByNoProxy("http://10.1.1.1/", "abc/8")).toBe(false);
      expect(shouldBypassByNoProxy("http://10.1.1.1/", "300.1.1.1/8")).toBe(false);
      expect(shouldBypassByNoProxy("http://10.1.1.1/", "10.0.0.0/")).toBe(false);
    });

    it("returns false for empty noProxy", () => {
      expect(shouldBypassByNoProxy("http://127.0.0.1/", "")).toBe(false);
      expect(shouldBypassByNoProxy("http://127.0.0.1/", undefined)).toBe(false);
    });
  });

  it("handles the documented combined env format", () => {
    const noProxy = "localhost,127.0.0.1,::1,.local,192.168.0.0/16,10.0.0.0/8";
    expect(shouldBypassByNoProxy("http://192.168.1.5:20127/", noProxy)).toBe(true);
    expect(shouldBypassByNoProxy("http://10.0.0.2/", noProxy)).toBe(true);
    expect(shouldBypassByNoProxy("http://localhost:20127/", noProxy)).toBe(true);
    expect(shouldBypassByNoProxy("https://api.example.com/", noProxy)).toBe(false);
  });
});
