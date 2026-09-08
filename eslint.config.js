import js from '@eslint/js';
import prettierCompat from 'eslint-config-prettier/flat';

// ---------------------------------------------------------------------------
// Phase 1 made `npm run lint` and `npm run format:check` blocking in CI
// (.github/workflows/lint-and-format.yml previously set continue-on-error on
// both, and then gated its annotation step on `if: failure()`, which could never
// be reached — the workflow always passed).
//
// The moment both gates are real, the fact that eslint and prettier were BOTH
// policing formatting stops being harmless. v0 set `indent`, `quotes` and `semi`
// here while .prettierrc set the same things, and `eslint-config-prettier` sat in
// devDependencies unused. Two tools with independent opinions about the same
// bytes means `npm run lint:fix` and `npm run format` can undo each other, which
// is not a conflict you want to discover from a red CI run on someone else's PR.
//
// Split cleanly: prettier owns layout, eslint owns correctness. The compat config
// below is last so it switches off every stylistic rule prettier handles.
// ---------------------------------------------------------------------------
export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        // Node 18+ globals. `fetch` is used by scripts/redis/limiter-proof.mjs to drive three
        // replicas without adding an HTTP client dependency — the whole point of these scripts
        // is that they run with what is already installed.
        fetch: 'readonly',
        AbortController: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      // `ignoreRestSiblings` is the documented way to allow the "omit a property
      // with rest" idiom — src/utils/cookies.js strips maxAge that way before
      // calling clearCookie. `varsIgnorePattern` covers a deliberately-unused
      // binding.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-arrow-callback': 'error',
      // Correctness rules worth having now that lint actually fails the build.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      // The exact shape of the two v0 bugs in logger.js and cookies.js: an
      // expression whose value is discarded, and a comma expression. Neither is
      // ever intentional in this codebase, and both read as correct code.
      'no-unused-expressions': ['error', { allowShortCircuit: false, allowTernary: false }],
      'no-sequences': 'error',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
  },
  {
    // k6 scripts run in the k6 JS runtime (goja), not Node. They have __ENV and
    // their own module resolution, and they are never executed by Node — so
    // linting them with Node globals produces false positives.
    files: ['benchmarks/k6/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/**', 'coverage/**', 'logs/**', 'drizzle/**'],
  },
  // Last, so it wins: disables every eslint rule that prettier already enforces.
  prettierCompat,
];
