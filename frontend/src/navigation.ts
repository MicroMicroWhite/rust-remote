import { useEffect, useState } from "react";

export function navigate(path: string) {
  location.hash = path;
}
export function useRoute() {
  const [path, setPath] = useState(() => location.hash.slice(1) || "/devices");
  useEffect(() => {
    const update = () => setPath(location.hash.slice(1) || "/devices");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const parts = path.split("/").filter(Boolean);
  const page: "devices" | "connections" | "audit" | "client-config" =
    parts[0] === "audit" || parts[0] === "connections" || parts[0] === "client-config" ? parts[0] : "devices";
  let deviceId: string | null = null;
  try {
    deviceId =
      page === "devices" && parts[1] ? decodeURIComponent(parts[1]) : null;
  } catch {}
  return { page, deviceId, tab: parts[2] || "overview" };
}
