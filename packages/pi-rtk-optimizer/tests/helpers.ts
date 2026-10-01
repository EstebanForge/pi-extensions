import { test as vitestTest, vi } from "vitest";

import { DEFAULT_RTK_INTEGRATION_CONFIG, type RtkIntegrationConfig } from "../lib/types";

type TestResult = void | Promise<void>;
type MockModuleOptions = { namedExports?: Record<string, unknown>; defaultExport?: unknown };

// Vitest port of the upstream bun/node dual-runtime harness. Upstream ran the
// files directly with `bun`, executing runTest bodies immediately; vitest
// registers them instead and preserves declaration order within a file.
export function runTest(name: string, testFn: () => TestResult): void {
	vitestTest(name, testFn);
}

export function cloneDefaultConfig(): RtkIntegrationConfig {
	return structuredClone(DEFAULT_RTK_INTEGRATION_CONFIG);
}

// Upstream API shape kept: mock.module(specifier, { namedExports, defaultExport }).
// Maps onto vi.doMock (non-hoisted, affects only imports made after the call),
// with a registry reset so repeated mocks in one file re-mock cleanly.
export const mock = {
	module(specifier: string, options: MockModuleOptions): void {
		vi.resetModules();
		vi.doMock(specifier, () => {
			const moduleExports: Record<string, unknown> = {};
			if (options.defaultExport !== undefined) {
				moduleExports.default = options.defaultExport;
			}
			if (options.namedExports) {
				Object.assign(moduleExports, options.namedExports);
			}
			return moduleExports;
		});
	},
};
