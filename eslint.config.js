import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

// Adapted from /spa-application/eslint.config.js. The Svelte plugin and the project-local rules
// (page/layout patterns, route strings, hardcoded UI strings) are dropped — this is a plain TS +
// Vite package with no Svelte, routing, or localization. The strict type-aware rules are kept but
// downgraded to warnings because the viewer wraps the untyped xeokit SDK (`any` at the boundary).
const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			'@typescript-eslint/no-unused-vars': 'warn'
		}
	},
	{
		// Type-checking for source code only (not config files)
		files: ['src/**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				parser: ts.parser
			}
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unsafe-return': 'warn',
			'@typescript-eslint/no-unsafe-argument': 'warn'
		}
	}
);
