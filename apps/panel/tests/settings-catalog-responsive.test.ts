import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(
  path.resolve(process.cwd(), "components/settings-panels.module.css"),
  "utf8",
);

describe("settings catalog responsive layout", () => {
  it("removes the catalog table minimum width at responsive sizes", () => {
    expect(css).toMatch(
      /@media \(max-width: 48rem\) \{[\s\S]*\.catalogTable \{[^}]*min-width: 0;[^}]*width: 100%;/,
    );
  });

  it("allows catalog row actions to wrap instead of escaping the row", () => {
    expect(css).toMatch(
      /@media \(max-width: 48rem\) \{[\s\S]*\.catalogTable td\[data-label="Ações"\] > :global\(\.flex\) \{[^}]*flex-wrap: wrap;/,
    );
  });
});
