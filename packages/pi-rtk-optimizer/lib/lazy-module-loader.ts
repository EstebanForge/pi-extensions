/**
 * Creates a memoized lazy loader for a dynamically imported module.
 *
 * The first call triggers `import(specifier)`; subsequent calls reuse the
 * cached promise. This avoids re-importing the module on every invocation
 * while keeping the heavy module out of the synchronous startup path.
 */
export function createLazyModuleLoader<T>(specifier: string): () => Promise<T> {
	let cached: Promise<T> | undefined;
	return (): Promise<T> => {
		cached ??= import(specifier) as Promise<T>;
		return cached;
	};
}
