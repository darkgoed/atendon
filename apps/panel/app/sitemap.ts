import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://atendon.alpdash.com.br/login", changeFrequency: "monthly", priority: 0.5 }];
}
