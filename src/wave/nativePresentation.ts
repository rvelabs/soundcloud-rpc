import type { WebContents } from 'electron';
export type FinishPresentation = () => Promise<void>;
export const nativePresentations = new WeakMap<WebContents, () => Promise<FinishPresentation>>();
export const beginNativePageCover = (contents: WebContents): Promise<FinishPresentation> =>
    nativePresentations.get(contents)?.() || Promise.resolve(async () => {});
