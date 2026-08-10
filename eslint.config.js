'use strict';
// Flat config. Matches the ERP backend's conventions: CommonJS, Node globals.
module.exports = [
  {
    files: ['src/**/*.js', '__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly',
        console: 'readonly', __dirname: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        fetch: 'readonly', AbortController: 'readonly', globalThis: 'readonly',
        describe: 'readonly', test: 'readonly', expect: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', jest: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
];
