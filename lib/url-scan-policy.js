/**
 * Prevent SSRF / internal network scanning when the app is exposed publicly.
 * Set ALLOW_INTERNAL_SCANS=true for local development (localhost, private IPs).
 */
import dns from "node:dns/promises";
import net from "node:net";

/**
 * @param {string} ipv4
 * @returns {boolean}
 */
function isPrivateOrReservedIPv4(ipv4) {
  const p = ipv4.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * @param {string} ipv6
 * @returns {boolean}
 */
function isPrivateOrReservedIPv6(ipv6) {
  const s = ipv6.toLowerCase();
  if (s === "::1") return true;
  if (s.startsWith("fe80:")) return true; // link-local
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // ULA
  if (s.startsWith("::ffff:")) {
    const v4 = s.slice(7);
    if (net.isIPv4(v4)) return isPrivateOrReservedIPv4(v4);
  }
  return false;
}

/**
 * @param {string} urlString
 * @returns {Promise<void>}
 * @throws {Error} code BLOCKED_HOST
 */
export async function assertPublicScanTarget(urlString) {
  if (process.env.ALLOW_INTERNAL_SCANS === "true") return;

  let u;
  try {
    u = new URL(urlString);
  } catch {
    const err = new Error("Invalid URL");
    err.code = "BLOCKED_HOST";
    throw err;
  }

  const host = u.hostname;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host.endsWith(".local")
  ) {
    const err = new Error("Host not allowed");
    err.code = "BLOCKED_HOST";
    throw err;
  }

  if (net.isIP(host)) {
    if (net.isIPv4(host) && isPrivateOrReservedIPv4(host)) {
      const err = new Error("IP not allowed");
      err.code = "BLOCKED_HOST";
      throw err;
    }
    if (net.isIPv6(host) && isPrivateOrReservedIPv6(host)) {
      const err = new Error("IP not allowed");
      err.code = "BLOCKED_HOST";
      throw err;
    }
    return;
  }

  try {
    const r = await dns.lookup(host, { all: false });
    const addr = r.address;
    if (net.isIPv4(addr) && isPrivateOrReservedIPv4(addr)) {
      const err = new Error("Resolves to a private address");
      err.code = "BLOCKED_HOST";
      throw err;
    }
    if (net.isIPv6(addr) && isPrivateOrReservedIPv6(addr)) {
      const err = new Error("Resolves to a private address");
      err.code = "BLOCKED_HOST";
      throw err;
    }
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "BLOCKED_HOST") throw e;
    const code = e && typeof e === "object" && "code" in e ? e.code : "";
    if (code === "ENOTFOUND" || code === "ENOTDATA" || code === "ESERVFAIL") {
      const err = new Error(`Host not found: ${host}`);
      err.code = "DNS_FAILED";
      throw err;
    }
    const err = new Error(`Could not verify host (${String(code || "lookup")})`);
    err.code = "DNS_FAILED";
    throw err;
  }
}
