// Automation addresses start at the desktop's Remote access route while it is up, so apps on the internet reach them;
// with it down the server goes back to this computer's own receiver.
export function syncHookOrigin({ status, wanted, request }) {
  const origin = wanted && status?.ready && status.endpoint ? status.endpoint : null;
  void request("/api/webhooks/public-origin", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }), signal: AbortSignal.timeout(10_000) })
    .then(response => response.body?.cancel(), () => {});
}
