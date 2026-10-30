const entrance = location.pathname.split("/").filter(Boolean)[0] || "";
export const validEntrance = /^[a-f0-9]{8}$/.test(entrance);
const base = `/${entrance}/api`;
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}

export function screenSocket(id: string, fps: number) {
  const url = new URL(`${base}/devices/${encodeURIComponent(id)}/screen`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ csrf_token: csrf, fps })));
  return socket;
}

export function terminalSocket(id: string, cols: number, rows: number) {
  const url = new URL(`${base}/devices/${encodeURIComponent(id)}/terminal`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ csrf_token: csrf, cols, rows })));
  return socket;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch(base + path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "/login" && path !== "/session")
      window.dispatchEvent(new Event("session-expired"));
    const body = await response.json().catch(() => ({ detail: "请求失败" }));
    const detail =
      typeof body.detail === "string" ? body.detail : "请求参数不正确";
    throw new Error(
      `${detail} · ${response.headers.get("X-Request-ID") || response.status}`,
    );
  }
  return response.json() as Promise<T>;
}

export async function command<T>(
  id: string,
  action: string,
  params = {},
): Promise<T> {
  const data = await api<{ result: T }>(
    `/devices/${encodeURIComponent(id)}/command`,
    {
      method: "POST",
      body: JSON.stringify({ action, params }),
    },
  );
  return data.result;
}

export async function download(id: string, path: string, name: string) {
  return downloadFile(`/devices/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`, name);
}

export async function downloadFile(path: string, name: string) {
  const response = await fetch(base + path, { credentials: "same-origin" });
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    const body = await response.json().catch(() => ({ detail: "下载失败" }));
    throw new Error(body.detail);
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
