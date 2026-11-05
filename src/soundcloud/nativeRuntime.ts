export function nativeRuntimeExports(loadPlaybackGate = false): unknown[] {
    type Runtime = ((id: string) => unknown) & { c: Record<string, { exports: unknown }>; m: Record<string, unknown> };
    const page = window as typeof window & { webpackJsonp?: unknown[]; __scRpcModules?: Runtime[] };
    if (!page.__scRpcModules) {
        const chunks = page.webpackJsonp;
        if (!Array.isArray(chunks) || !/\.push\.apply\(/.test(Function.prototype.toString.call(chunks.push))) return [];
        const runtimes: Runtime[] = [],
            key = 'sc_rpc_native_bridge';
        try {
            chunks.push([
                [key],
                {
                    [key]: (_module: unknown, _exports: unknown, runtime: Runtime) => {
                        if (runtime?.c && runtime?.m && !runtimes.includes(runtime)) runtimes.push(runtime);
                    },
                },
                [[key]],
            ]);
            for (const runtime of runtimes) {
                delete runtime.c[key];
                delete runtime.m[key];
            }
            if (!runtimes.length) return [];
            Object.defineProperty(page, '__scRpcModules', { value: runtimes, configurable: true });
        } catch {
            return [];
        }
    }
    const exports: unknown[] = [];
    for (const runtime of page.__scRpcModules || [])
        for (const module of Object.values(runtime.c)) {
            try {
                const value = module.exports;
                exports.push(value);
                if (value && typeof value === 'object' && 'default' in value) exports.push(value.default);
            } catch {}
        }
    if (
        loadPlaybackGate &&
        !exports.some((value) => typeof (value as { playWithSignupWall?: unknown })?.playWithSignupWall === 'function')
    ) {
        for (const runtime of page.__scRpcModules || []) {
            if (typeof runtime !== 'function') continue;
            const gate = Object.entries(runtime.m).find(([, factory]) => {
                if (typeof factory !== 'function') return false;
                const source = Function.prototype.toString.call(factory);
                return (
                    source.includes('playbackSignUpWallStore') &&
                    source.includes('playWithSignupWall') &&
                    source.includes('hard_wall_v2_anonymous_signup_prompt')
                );
            });
            if (gate) {
                try {
                    runtime(gate[0]);
                    return nativeRuntimeExports(false);
                } catch {}
            }
        }
    }
    return exports;
}
