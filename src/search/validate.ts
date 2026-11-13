import { isIP } from "node:net";
import type { SearchQuery } from "./types.ts";

export function publicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(host) || host.startsWith("[") || !host.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) {
    throw new Error("Expected a public HTTP(S) URL without credentials or a custom port.");
  }
  return url;
}

/** Remove tracking identifiers; preserve functional query parameters. */
export function canonicalUrl(value: string): string {
  const url = publicUrl(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

export function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeQuery(input: SearchQuery): SearchQuery {
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 1000) {
    throw new Error('Expected "query" to contain 1 to 1000 characters.');
  }
  if (input.publishedAfter !== undefined && !validDay(input.publishedAfter)) throw new Error("Invalid publication date.");
  if (input.publishedBefore !== undefined && (!validDay(input.publishedBefore)
    || Boolean(input.publishedAfter && input.publishedAfter > input.publishedBefore))) throw new Error("Invalid publication upper bound.");
  if (input.asOf && Number.isNaN(input.asOf.getTime())) throw new Error("Invalid snapshot cutoff.");
  if (input.asOf && input.publishedAfter && input.publishedAfter > input.asOf.toISOString().slice(0, 10)) {
    throw new Error("Publication date is after the snapshot cutoff.");
  }
  if (input.freshness !== undefined && !["standard", "fresh"].includes(input.freshness)) throw new Error("Invalid freshness policy.");
  if (input.domains && (input.domains.length > 10 || input.domains.some(d => typeof d !== "string"))) throw new Error("Expected at most 10 domains.");
  const domains = input.domains?.map(domain => {
    const clean = domain.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(clean)) throw new Error("Domains must be bare hostnames, such as example.com.");
    publicUrl(`https://${clean}`);
    return clean;
  });
  if (input.urls && (input.urls.length > 5 || input.urls.some(u => typeof u !== "string"))) throw new Error("Expected at most 5 source URLs.");
  const urls = input.urls?.map(canonicalUrl);
  return {
    query: input.query.trim(), publishedAfter: input.publishedAfter, publishedBefore: input.publishedBefore,
    domains: domains?.length ? [...new Set(domains)].sort() : undefined,
    urls: urls?.length ? [...new Set(urls)].sort() : undefined,
    asOf: input.asOf, freshness: input.freshness ?? "standard",
  };
}

export function matchesDomains(url: string, domains?: string[]): boolean {
  const host = new URL(url).hostname;
  return !domains?.length || domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}
