import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      // Vitest mocks use require() for module interception
      '@typescript-eslint/no-require-imports': 'off',
      // Intentional pattern in relay/signal EventEmitter typing
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
    },
  },
  {
    ignores: ['**/dist/', '**/node_modules/', '**/*.js', '**/*.d.ts'],
  },
);
