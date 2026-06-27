module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
    jest: true
  },
  extends: "eslint:recommended",
  plugins: ["@typescript-eslint"],
  overrides: [
    {
      files: ["__tests__/**/*.js", "**/*.test.js", "**/*.spec.js"],
      env: {
        jest: true
      },
      rules: {
        "no-console": "off",
        "require-await": "off"
      }
    },
    {
      files: ["__tests__/benchmarks/**/*.js"],
      rules: {
        "no-console": "off"
      }
    },
    // CLI executables: stdout is the product, not incidental logging. These
    // entrypoints are gated by `require.main === module` and print
    // user-facing output, so `console` is the correct sink (same rationale as
    // the benchmark exemption above).
    {
      files: ["src/bin/**/*.{ts,tsx}", "src/scripts/**/*.{ts,tsx}"],
      rules: {
        "no-console": "off"
      }
    },
    {
      files: ["**/*.jsx"],
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    // ── TypeScript sources ──────────────────────────────────────────────────
    // `eslint .` now covers .ts/.tsx (the legacy flat tree was previously
    // unlinted). Type-aware concerns (unused vars, undefined names) are owned
    // by `tsc --noEmit` (check:ts), so the corresponding lint rules are off to
    // avoid double-reporting / false positives on TS syntax.
    {
      files: ["**/*.ts", "**/*.tsx"],
      parser: "@typescript-eslint/parser",
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true }
      },
      rules: {
        "no-unused-vars": "off",
        "no-undef": "off",
        // Formatting is owned by Prettier (.prettierrc). The core ESLint
        // stylistic rules misfire on TS/TSX syntax (notably `indent`), so they
        // are disabled here — Prettier is the single formatting authority.
        indent: "off",
        quotes: "off",
        semi: "off",
        "comma-dangle": "off",
        curly: "off",
        // Downgraded (not silenced) on the legacy flat tree so the new lint
        // coverage does not block CI. The layered rewrite re-tightens these to
        // error as the old modules are replaced.
        eqeqeq: "warn",
        "no-useless-catch": "warn",
        "no-inner-declarations": "warn",
        "no-constant-condition": "warn"
      }
    },
    // ── Layer guardrails ────────────────────────────────────────────────────
    // Size/complexity caps for the layered tree (foundation/codec are live;
    // transport/domain/app/interface land in later phases). Warn now, error
    // later. The import-boundary rule below enforces dependency-inward layering.
    {
      files: [
        "src/foundation/**/*.{ts,tsx}",
        "src/codec/**/*.{ts,tsx}",
        "src/transport/**/*.{ts,tsx}",
        "src/domain/**/*.{ts,tsx}",
        "src/app/**/*.{ts,tsx}",
        "src/interface/**/*.{ts,tsx}"
      ],
      rules: {
        // Target: small, single-purpose modules (~<400 LOC, doc 01/02).
        "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
        "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
        "max-statements": ["warn", 30],
        complexity: ["warn", 15]
      }
    },
    // Import-boundary rule: a module may import only its own layer or layers
    // BELOW it (foundation < codec < transport < domain < app < interface).
    // Encoded as no-restricted-imports patterns per layer (warn now, error
    // later). Patterns for not-yet-created layers are inert until those
    // directories exist.
    {
      files: ["src/foundation/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "warn",
          {
            patterns: [
              "**/codec/**",
              "**/transport/**",
              "**/domain/**",
              "**/app/**",
              "**/interface/**"
            ]
          }
        ]
      }
    },
    {
      files: ["src/codec/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "warn",
          { patterns: ["**/transport/**", "**/domain/**", "**/app/**", "**/interface/**"] }
        ]
      }
    },
    {
      files: ["src/transport/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "warn",
          { patterns: ["**/domain/**", "**/app/**", "**/interface/**"] }
        ]
      }
    },
    {
      files: ["src/domain/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": ["warn", { patterns: ["**/app/**", "**/interface/**"] }]
      }
    },
    {
      files: ["src/app/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": ["warn", { patterns: ["**/interface/**"] }]
      }
    }
  ],
  ignorePatterns: [
    "public/**",
    "node_modules/**",
    "coverage/**",
    "lib/**",
    "__conformance__/vectors/**"
  ],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  rules: {
    // Error prevention
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-prototype-builtins": "error",
    eqeqeq: ["error", "always"],
    "no-var": "error",
    "prefer-const": "error",

    // Security
    "no-eval": "error",
    "no-implied-eval": "error",

    // Best practices
    curly: ["error", "all"],
    "no-throw-literal": "error",
    "require-await": "warn",

    // Style
    semi: ["error", "always"],
    quotes: ["error", "double", { avoidEscape: true }],
    indent: ["error", 2, { SwitchCase: 1 }],
    "comma-dangle": ["error", "never"]
  }
};
