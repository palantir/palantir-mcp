/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixupPluginRules } from '@eslint/compat'
import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import _import from 'eslint-plugin-import'
import licenseHeader from 'eslint-plugin-license-header'
import globals from 'globals'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

export default defineConfig([
  {
    ignores: ['dist/**'],
  },
  {
    extends: compat.extends('eslint:recommended', 'plugin:@typescript-eslint/recommended'),

    plugins: {
      '@typescript-eslint': typescriptEslint,
      import: fixupPluginRules(_import),
      'license-header': licenseHeader,
    },

    languageOptions: {
      globals: {
        ...globals.node,
      },

      parser: tsParser,
    },

    rules: {
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
        },
      ],

      '@typescript-eslint/no-empty-object-type': 'off',

      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],

          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],

      'eol-last': ['error', 'always'],
      'license-header/header': ['error', './license-header.txt'],
    },
  },
  {
    files: ['src/auth/**/*.ts', 'src/tokenProvider.ts', 'src/legacyTokenProvider.ts'],
    rules: {
      'license-header/header': [
        'error',
        readFileSync(new URL('./license-header.txt', import.meta.url), 'utf8')
          .replace('2025', '2026')
          .trimEnd()
          .split('\n'),
      ],
    },
  },
])
