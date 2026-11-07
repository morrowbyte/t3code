import { GITHUB_REPOSITORY_URL } from "./site";

export const SITE_ORIGIN = import.meta.env.SITE || undefined;
export const SITE_NAME = "Crew";
export const SITE_TAGLINE = "One workspace for conversations, research, code, and delegated work";

export const OFFICIAL_PROFILES = [GITHUB_REPOSITORY_URL] as const;

export type JsonLd = Record<string, unknown>;

const ORGANIZATION_ID = `${SITE_ORIGIN ?? ""}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN ?? ""}/#website`;
const SOFTWARE_ID = `${SITE_ORIGIN ?? ""}/#software`;

export const absoluteUrl = (pathname: string): string =>
  SITE_ORIGIN ? new URL(pathname, SITE_ORIGIN).href : pathname;

export const organizationJsonLd = (): JsonLd => ({
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "Morrowbyte",
  url: SITE_ORIGIN,
  logo: absoluteUrl("/apple-touch-icon.png"),
  sameAs: ["https://github.com/morrowbyte"],
});

export const websiteJsonLd = (): JsonLd => ({
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: SITE_NAME,
  url: SITE_ORIGIN,
  publisher: { "@id": ORGANIZATION_ID },
});

export const softwareJsonLd = (): JsonLd => ({
  "@type": "SoftwareApplication",
  "@id": SOFTWARE_ID,
  name: SITE_NAME,
  description: `${SITE_NAME}. ${SITE_TAGLINE}.`,
  url: SITE_ORIGIN,
  downloadUrl: absoluteUrl("/download"),
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Windows, Linux, Android",
  license: "https://opensource.org/license/mit",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  publisher: { "@id": ORGANIZATION_ID },
  sameAs: [...OFFICIAL_PROFILES],
});

export const breadcrumbJsonLd = (items: ReadonlyArray<{ name: string; path: string }>): JsonLd => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.name,
    item: absoluteUrl(item.path),
  })),
});

export const jsonLdGraph = (nodes: ReadonlyArray<JsonLd>): string =>
  // `<` is escaped so page text inside the graph can never close the script tag.
  JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replace(/</g, "\\u003c");

// Indexable static pages. The 404 (noindex) and the /95 easter egg stay out of the sitemap.
export const STATIC_PAGES = [
  { path: "/", priority: "1.0" },
  { path: "/download", priority: "0.9" },
  { path: "/legal", priority: "0.3" },
  { path: "/privacy-policy", priority: "0.3" },
  { path: "/security-policy", priority: "0.3" },
  { path: "/terms-of-service", priority: "0.3" },
] as const;
