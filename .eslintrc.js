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
      }
    },
    {
      files: ["**/*.jsx"],
      plugins: ["react"],
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      rules: {
        "react/jsx-uses-react": "error",
        "react/jsx-uses-vars": "error"
      }
    }
  ],
  ignorePatterns: ["public/**", "node_modules/**", "coverage/**"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  rules: {
    // Error prevention
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-console": "off",
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
