import { useEffect, useRef, useState } from "react";
import { command } from "./api";
import type { Device } from "./types";

type SystemDetails = Pick<Device, "os" | "distribution_id" | "kernel_version">;

// Older clients already support system.info, but do not include it in hello.
// Fill missing versions while viewing the list; the backend also persists them.
export function useDeviceSystems(devices: Device[]) {
  const [details, setDetails] = useState<Record<string, SystemDetails>>({});
  const requests = useRef(new Map<string, number>());
  const pending = useRef(new Set<string>());

  useEffect(() => {
    for (const device of devices) {
      if (pending.current.size >= 4) break;
      if (!device.online || device.os?.trim() || pending.current.has(device.id)
        || (requests.current.get(device.id) || 0) > Date.now()) continue;
      pending.current.add(device.id);
      requests.current.set(device.id, Date.now() + 60_000);
      void command<SystemDetails>(device.id, "system.info")
        .then((result) => {
          if (typeof result?.os !== "string" || !result.os.trim()) return;
          requests.current.set(device.id, Infinity);
          setDetails((current) => ({
            ...current,
            [device.id]: {
              os: result.os,
              distribution_id: typeof result.distribution_id === "string" ? result.distribution_id : null,
              kernel_version: typeof result.kernel_version === "string" ? result.kernel_version : null,
            },
          }));
        })
        // Keep the list usable when a device disconnects or is busy; retry on a later poll.
        .catch(() => {})
        .finally(() => pending.current.delete(device.id));
    }
  }, [devices]);

  return devices.map((device) => device.os?.trim() || !details[device.id]
    ? device : { ...device, ...details[device.id] });
}
