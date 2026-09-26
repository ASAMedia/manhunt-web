'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
};

module.exports = [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  {
    files: ['server.js', 'src/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: globals.node },
    rules,
  },
  {
    files: ['public/**/*.js'],
    ignores: ['public/sw.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023, globals: { ...globals.browser, L: 'readonly' } },
    rules,
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 2023, globals: globals.serviceworker },
    rules,
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023, globals: globals.node },
    rules,
  },
];
