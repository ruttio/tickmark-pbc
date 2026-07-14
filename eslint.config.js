// Focused lint gate — the goal here is to fail the build on *real* bugs
// (undefined variables, duplicate keys, unreachable code, …) the way the
// `filtered is not defined` white-screen would have been caught, WITHOUT
// drowning us in style/unused-var noise on the existing code.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "supabase/**", // Deno runtime, different globals — not linted here
      "**/*.min.js",
      "Dashboard*/**", // design-handoff scratch folders
      "Tickmark website*/**",
      ".claude/**", ".agents/**", ".codex/**", ".codex-pet-runs/**", // agent/skill tooling, not project source
      ".github/skills/**", ".github/hooks/**",
      "_*.html",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Keep the high-signal bug rules from `recommended` as errors
      // (no-undef, no-dupe-keys, no-unreachable, no-const-assign, …).
      // Silence the noisy stylistic ones so the gate only trips on real defects.
      "no-unused-vars": "off",
      "no-empty": "off",
      "no-constant-condition": ["warn", { checkLoops: false }],
      // Real hook bugs (calling hooks conditionally / out of order) fail the build;
      // exhaustive-deps stays a non-blocking warning (already disabled inline where intended).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
