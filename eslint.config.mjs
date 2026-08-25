import { FlatCompat } from "@eslint/eslintrc";
import globals from "globals";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: projectRoot });
const panelFiles = ["apps/panel/**/*.{js,jsx,ts,tsx}"];
const backendFiles = ["apps/backend/**/*.ts"];

const panelConfig = compat
  .extends("next/core-web-vitals", "next/typescript")
  .map((config) => ({ ...config, files: panelFiles }));

const backendConfig = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: backendFiles
}));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "graphify-out/**"
    ]
  },
  ...backendConfig,
  {
    files: backendFiles,
    languageOptions: { globals: globals.node }
  },
  ...panelConfig,
  {
    files: panelFiles,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "apps/panel" } },
    rules: { "@next/next/no-html-link-for-pages": "off" }
  }
);
