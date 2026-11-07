declare module 'soundcloud-wave-ui' {
    export function installWaveUI(): void;
}
declare module '*.css' {
    const css: string;
    export default css;
}

declare module 'soundcloud-builtin-plugin' {
    const plugin: { contentScript: () => string };
    export default plugin;
}
