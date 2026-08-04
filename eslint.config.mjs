import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * House style + pragmas adapted from nxt-backend `eslint.config.mjs` teamRules
 * (ADR-004). Dropped: @nx/eslint-plugin, estate-only no-restricted-imports.
 */
const teamRules = {
  'no-debugger': 'off',
  'no-console': [ 'warn', { allow: [ 'info', 'warn', 'error' ] } ],
  'one-var': [ 'warn', 'never' ],
  eqeqeq: [ 'warn', 'smart' ],
  'id-length': [ 'warn', { min: 2, properties: 'never', exceptions: [ 'i' ] } ],
  'dot-notation': 'warn',
  semi: [ 'warn', 'always' ],
  indent: [ 'warn', 2, { SwitchCase: 1 } ],
  'no-multiple-empty-lines': 'warn',
  quotes: [ 'warn', 'single' ],
  'comma-dangle': [
    'warn',
    {
      arrays: 'always-multiline',
      objects: 'always-multiline',
      imports: 'always-multiline',
      exports: 'always-multiline',
      functions: 'always-multiline',
    },
  ],
  'array-bracket-spacing': [ 'warn', 'always' ],
  'object-curly-spacing': [ 'warn', 'always' ],
  'template-curly-spacing': [ 'warn', 'always' ],
  'arrow-parens': [ 'warn', 'as-needed' ],
  'brace-style': [ 'warn', 'stroustrup', { allowSingleLine: true } ],
  'no-trailing-spaces': 'warn',
  'eol-last': 'warn',
  '@typescript-eslint/no-var-requires': 'off',
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-require-imports': 'off',
  'no-undef': 'off',
  'no-warning-comments': 'off',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'eslint.config.mjs',
      'src/http/smoke/**/*.http',
    ],
  },
  {
    files: [ '**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts' ],
    rules: teamRules,
  },
  {
    // httpYac env helper is CommonJS (`module.exports`); not covered by the TS block.
    files: [ 'src/http/smoke/**/*.cjs' ],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
      },
    },
  },
);
