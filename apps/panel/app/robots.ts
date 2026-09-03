import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/login", "/llms.txt"], disallow: "/" }],
    sitemap: "https://atendon.alpdash.com.br/sitemap.xml"
  };
}
