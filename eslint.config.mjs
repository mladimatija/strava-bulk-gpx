import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier/flat';
import globals from 'globals';

export default tseslint.config(
	// Ignore-list must live in its own object with no other keys.
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'.vite/**',
			'.turbo/**',
			'coverage/**',
			'icons/icon-*.png',
			// Auto-generated from the Ko-fi PNG - a giant base64 string,
			// linting it produces noise without value.
			'src/kofi-asset.ts',
			'*.zip',
		],
	},

	// Baseline JS rules - apply everywhere (TS, JS, MJS).
	js.configs.recommended,

	// Type-aware TS rules. Scoped via `files` so they only apply to files in
	// our tsconfig.json. Outside of this block, type-aware rules would fire
	// on eslint.config.mjs / scripts/*.js, which have no associated program.
	{
		files: ['src/**/*.ts', 'vite.config.ts', 'tests/**/*.ts', 'playwright.config.ts'],
		extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
		languageOptions: {
			parserOptions: {
				// projectService is the modern (tseslint v8+) replacement for
				// `project: './tsconfig.json'`. It uses the TS Language Service
				// directly, auto-discovers the nearest tsconfig, and is materially
				// faster than spinning up a separate ts.Program.
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/no-explicit-any': 'error',
			// We deliberately use `!` after explicit `noUncheckedIndexedAccess`
			// bounds checks - see downloader.ts.
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
		},
	},

	// Project-wide quality rules (apply to JS + TS, no type info needed).
	{
		rules: {
			'no-unused-vars': 'off',
			'no-console': 'off',
			'no-debugger': 'error',
			'no-duplicate-imports': 'error',
			'no-var': 'error',
			'prefer-const': 'error',
			eqeqeq: ['error', 'always'],
		},
	},

	// Browser globals - content script + downloader run inside Strava's page.
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			globals: {
				...globals.browser,
				chrome: 'readonly',
			},
		},
	},

	// Node globals - vite config + Playwright test files run under Node.
	{
		files: ['vite.config.ts', 'tests/**/*.ts', 'playwright.config.ts'],
		languageOptions: {
			globals: globals.node,
		},
	},

	// Node.js build scripts (clean, build-icons, build-kofi). No type info is
	// involved; these are pure Node ESM.
	{
		files: ['scripts/**/*.js', 'eslint.config.mjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.node,
		},
	},

	// Must be last: disables every rule Prettier would conflict with.
	prettierConfig,
);
