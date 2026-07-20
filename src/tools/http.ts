export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      // Naver/Yahoo endpoints reject default undici UA
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
