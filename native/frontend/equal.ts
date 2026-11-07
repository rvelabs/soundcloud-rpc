export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const left = Object.keys(a),
        right = Object.keys(b);
    return (
        left.length === right.length &&
        left.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(b, key) &&
                isDeepStrictEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
        )
    );
}
