import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

const config = [
  includeIgnoreFile(gitignorePath),
  ...oclif,
  prettier,
  {
    rules: {
      // Keep existing interfaces; switching to `type` is pure churn.
      '@typescript-eslint/consistent-type-definitions': 'off',
      // Public store APIs return `null` for "not found".
      '@typescript-eslint/no-restricted-types': 'off',
      // MCP JSON schema uses `required`; renaming booleans isn't worth the churn.
      'unicorn/consistent-boolean-name': 'off',
      // Conflicts with perfectionist/sort-classes, which oclif already enforces.
      'unicorn/consistent-class-member-order': 'off',
      // oclif intends named `node:path` imports, but unicorn now normalizes the key to `path`.
      'unicorn/import-style': ['error', {styles: {path: {named: true}}}],
      // Underscore-prefixed members are injectable test seams; `#private` fields can't be stubbed.
      'unicorn/prefer-private-class-fields': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests stub out methods like `log` with no-op functions.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
]

export default config
