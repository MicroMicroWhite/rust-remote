export function bytes(n: number) {
  if (!n) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][i]}`;
}
export function date(n: number) {
  return new Date(n * 1000).toLocaleString("zh-CN", { hour12: false });
}
export function dateOnly(n: number) {
  return new Date(n * 1000).toLocaleDateString("zh-CN");
}
export function dateTime(n: number) {
  const value = new Date(n * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
export function relativeTime(n: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - n));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
