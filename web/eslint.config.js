import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import { defineConfig } from "eslint/config";
import ts from "typescript-eslint";

import svelteConfig from "./svelte.config.js";

export default defineConfig(
  { ignores: [".svelte-check/", "dist/", "node_modules/"] },
  js.configs.recommended,
  ...ts.configs.strictTypeChecked,
  ...ts.configs.stylisticTypeChecked,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: { parser: ts.parser, svelteConfig },
    },
  },
  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "svelte/no-at-html-tags": "error",
      "svelte/require-each-key": "error",
      "svelte/valid-compile": "error",
      "svelte/no-unused-svelte-ignore": "error",
      "svelte/block-lang": ["error", { script: "ts" }],
    },
  },
  {
    files: ["*.config.js", "*.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
