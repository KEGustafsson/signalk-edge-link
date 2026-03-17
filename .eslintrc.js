module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
    jest: true
  },
  extends: "eslint:recommended",
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
      files: ["test/benchmarks/**/*.js"],
      rules: {
        "no-console": "off"
      }
    },
    {
      files: ["**/*.jsx"],
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    }
  ],
  ignorePatterns: ["public/**", "node_modules/**", "coverage/**", "lib/**"],
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
