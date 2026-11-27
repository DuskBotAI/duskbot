/** The account client's network: Chromium's stack first, so the computer's own proxy settings, certificate store and
 * resolver apply as they do for the browser that opens the sign-in page. Electron's main-process `fetch` is Node's and
 * ignores all three, so behind a proxy, a filtering antivirus or a network that only the browser is let through, the
 * sign-in could not reach dusk.bot while the website opened fine. Node's stack is tried when Chromium's fails to connect. */
export function chromiumFirstFetch(chromium, node = globalThis.fetch) {
  return async function accountFetch(url, init = {}) {
    try {
      return await chromium(url, init);
    } catch (error) {
      if (init.signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      return node(url, init);
    }
  };
}
