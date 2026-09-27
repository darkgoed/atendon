import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata as rootMetadata } from "@/app/layout";
import { metadata as loginMetadata } from "@/app/login/layout";

describe("crawler contracts", () => {
  it("keeps the private panel out of indexes by default", () => {
    expect(rootMetadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("exposes only the canonical login page", () => {
    expect(loginMetadata.alternates).toEqual({ canonical: "/login" });
    expect(loginMetadata.robots).toMatchObject({ index: true, follow: true });
    expect(sitemap()).toEqual([{ url: "https://atendon.alpdash.com.br/login", changeFrequency: "monthly", priority: 0.5 }]);
  });

  it("allows login and disallows every other path", () => {
    expect(robots()).toEqual({
      rules: [{ userAgent: "*", allow: ["/login", "/llms.txt"], disallow: "/" }],
      sitemap: "https://atendon.alpdash.com.br/sitemap.xml"
    });
  });
});
