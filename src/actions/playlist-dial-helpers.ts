/** Wraps an index into [0, length), so scrolling past either end loops around. */
export function wrapIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return ((index % length) + length) % length;
}

/** Shortens text to at most `max` characters, ending in an ellipsis when cut. */
export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
