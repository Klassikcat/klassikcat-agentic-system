// Flat ESLint config (ESLint v9/v10) for the opencode/pi hook packages.
//
// The repo is a collection of independent Node ESM packages (hooks-pi/*,
// hooks-opencode/*, agents-*/*). Everything targets Node >=20 and ES modules,
// so this single root config covers all of them.
//
// Self-contained: no external config packages required, so it runs with just a
// globally- or locally-installed `eslint`. Run with:
//   npx eslint .   (or:  eslint .)

// Globals available in the Node ESM runtime these hooks execute in.
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  globalThis: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
};

export default [
  // Don't lint dependencies, orchestration working state, or generated output.
  {
    ignores: [
      "**/node_modules/**",
      ".omc/**",
      ".omo/**",
      ".serverless/**",
    ],
  },

  // Node ESM source files (.js here are ESM because each package declares
  // "type": "module"; .mjs is always ESM).
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-undef": "error",
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },

  // Test scripts may intentionally throw / use process.exit and looser checks.
  {
    files: ["**/scripts/*.mjs", "**/*.test.{js,mjs}"],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
