// Talks to the AutoEdit Engine running on this computer.

const Engine = (() => {
  let base = 'http://127.0.0.1:47380';

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `O motor respondeu ${res.status}.`);
    return data;
  }

  return {
    setBase(url) { base = (url || base).replace(/\/$/, ''); },
    health: () => call('GET', '/health'),
    start: (req) => call('POST', '/jobs', req),
    status: (id) => call('GET', `/jobs/${id}`),
    cancel: (id) => call('POST', `/jobs/${id}/cancel`, {}),
    rebuild: (id, keep) => call('POST', `/jobs/${id}/rebuild`, { keep }),
  };
})();
