export interface ExternalNavigationTarget {
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'allow' | 'deny' },
  ): void;
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault(): void }, url: string) => void,
  ): void;
}

type OpenExternal = (url: string) => Promise<unknown>;

const EXTERNAL_PROTOCOLS: Record<string, true> = {
  'http:': true,
  'https:': true,
  'mailto:': true,
};

/** Keeps web links out of Electron while preventing unsupported navigation schemes. */
export function installExternalNavigation(
  target: ExternalNavigationTarget,
  appUrl: string,
  openExternal: OpenExternal,
): void {
  const appOrigin = new URL(appUrl).origin;
  const open = (url: string): void => {
    try {
      if (!EXTERNAL_PROTOCOLS[new URL(url).protocol]) return;
      void openExternal(url).catch(() => undefined);
    } catch {
      // Malformed URLs are blocked.
    }
  };

  target.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });

  target.on('will-navigate', (event, url) => {
    let targetOrigin: string | undefined;
    try {
      targetOrigin = new URL(url).origin;
    } catch {
      // Unsupported URLs are blocked below.
    }
    if (targetOrigin === appOrigin) return;

    event.preventDefault();
    open(url);
  });
}
