module.exports = {
  extends: ['eslint:recommended', 'plugin:prettier/recommended'],
  env: {
    node: true,
    es6: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prettier/prettier': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      // Test files use jest globals (describe/it/expect/beforeAll/etc.) and
      // can console.log freely for debugging.
      files: ['tests/**/*.js'],
      env: { jest: true },
      rules: {
        'no-console': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'dashboard/'],
};
