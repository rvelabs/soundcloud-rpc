import type { WebContents } from 'electron';
export async function nativeLikeModel(request: {
    id: number;
    accountId: number;
    sync: boolean;
    liked: boolean;
}): Promise<boolean> {
    type Runtime = { c: Record<string, { exports: unknown }>; m: Record<string, unknown> };
    const page = window as typeof window & {
        webpackJsonp?: unknown[];
        __scRpcModules?: Runtime[];
    };
    if (!Number.isSafeInteger(request.id) || !Number.isSafeInteger(request.accountId)) return false;
    if (!page.__scRpcModules) {
        const chunks = page.webpackJsonp;
        if (!Array.isArray(chunks) || !/\.push\.apply\(/.test(Function.prototype.toString.call(chunks.push)))
            return false;
        const runtimes: Runtime[] = [];
        const key = 'sc_rpc_native_likes';
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
            if (!runtimes.length) return false;
            Object.defineProperty(page, '__scRpcModules', { value: runtimes, configurable: true });
        } catch {
            return false;
        }
    }
    type NativeModel = { id: number; get: (name: string) => unknown };
    type NativeClass = {
        prototype?: { resource_type?: string };
        instances?: { find: (predicate: (model: NativeModel) => boolean) => NativeModel | undefined };
    };
    type Actions = {
        like: (model: NativeModel, liked: boolean, options: { persist: boolean }) => PromiseLike<unknown>;
        notify: unknown;
        addToPlayHistory: unknown;
    };
    type Auth = { isLoggedIn: () => boolean; currentUserId: () => number };
    for (const runtime of page.__scRpcModules || []) {
        const exports: unknown[] = [];
        for (const module of Object.values(runtime.c)) {
            try {
                const value = module.exports;
                exports.push(value);
                if (value && typeof value === 'object' && 'default' in value) exports.push(value.default);
            } catch {}
        }
        const auth = exports.find(
            (value) =>
                value &&
                typeof (value as Auth).isLoggedIn === 'function' &&
                typeof (value as Auth).currentUserId === 'function',
        ) as Auth | undefined;
        if (!auth || !auth.isLoggedIn() || auth.currentUserId() !== request.accountId) continue;
        const actions = exports.find(
            (value) =>
                value &&
                typeof (value as Actions).like === 'function' &&
                typeof (value as Actions).notify === 'function' &&
                typeof (value as Actions).addToPlayHistory === 'function',
        ) as Actions | undefined;
        const modelClass = exports.find(
            (value) =>
                (value as NativeClass)?.prototype?.resource_type === 'sound' &&
                typeof (value as NativeClass).instances?.find === 'function',
        ) as NativeClass | undefined;
        const model = modelClass?.instances?.find((model) => model.id === request.id);
        if (!actions || !model) continue;
        if (!request.sync) return true;
        try {
            await Promise.resolve(actions.like(model, request.liked, { persist: false }));
            return true;
        } catch {
            return false;
        }
    }
    return false;
}
export async function nativeLikeBridge(
    contents: WebContents,
    request: Parameters<typeof nativeLikeModel>[0],
): Promise<boolean> {
    if (contents.isDestroyed()) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            contents
                .executeJavaScript(`(${nativeLikeModel.toString()})(${JSON.stringify(request)})`, true)
                .catch(() => false),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), 3000);
                timer.unref();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
