import { Tag } from "antd";
import { Monitor } from "lucide-react";
import i18n from "./i18n";
import type { Device } from "./types";
import windows from "./assets/os/windows.svg?raw";
import linux from "./assets/os/linux.svg?raw";
import debian from "./assets/os/debian.svg?raw";
import ubuntu from "./assets/os/ubuntu.svg?raw";
import centos from "./assets/os/centos.svg?raw";
import fedora from "./assets/os/fedora.svg?raw";
import arch from "./assets/os/archlinux.svg?raw";
import alpine from "./assets/os/alpinelinux.svg?raw";
import rocky from "./assets/os/rockylinux.svg?raw";
import alma from "./assets/os/almalinux.svg?raw";
import redhat from "./assets/os/redhat.svg?raw";
import suse from "./assets/os/opensuse.svg?raw";
import mint from "./assets/os/linuxmint.svg?raw";
import kali from "./assets/os/kalilinux.svg?raw";
import raspberry from "./assets/os/raspberrypi.svg?raw";
import apple from "./assets/os/apple.svg?raw";
import freebsd from "./assets/os/freebsd.svg?raw";

// Match the reported distribution before its parent (e.g. Mint before Ubuntu).
const distributions = [
  { ids: ["linuxmint"], pattern: /\blinux mint\b/i, icon: mint, name: "Linux Mint" },
  { ids: ["kali"], pattern: /\bkali\b/i, icon: kali, name: "Kali Linux" },
  { ids: ["raspbian"], pattern: /\b(raspbian|raspberry pi)\b/i, icon: raspberry, name: "Raspberry Pi OS" },
  { ids: ["ubuntu"], pattern: /\bubuntu\b/i, icon: ubuntu, name: "Ubuntu" },
  { ids: ["debian"], pattern: /\bdebian\b/i, icon: debian, name: "Debian" },
  { ids: ["centos"], pattern: /\bcentos\b/i, icon: centos, name: "CentOS" },
  { ids: ["rocky"], pattern: /\brocky\b/i, icon: rocky, name: "Rocky Linux" },
  { ids: ["almalinux"], pattern: /\balmalinux\b/i, icon: alma, name: "AlmaLinux" },
  { ids: ["rhel", "redhat"], pattern: /\b(red hat|rhel)\b/i, icon: redhat, name: "Red Hat Enterprise Linux" },
  { ids: ["fedora"], pattern: /\bfedora\b/i, icon: fedora, name: "Fedora" },
  { ids: ["arch", "archlinux"], pattern: /\barch(?: linux)?\b/i, icon: arch, name: "Arch Linux" },
  { ids: ["alpine"], pattern: /\balpine\b/i, icon: alpine, name: "Alpine Linux" },
  { ids: ["opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles", "sled"], pattern: /\b(open)?suse\b/i, icon: suse, name: "openSUSE" },
];

export function operatingSystem(device: Device) {
  const platform = device.platform.toLowerCase();
  const raw = device.os?.trim();
  const reported = platform === "linux" ? raw?.replace(/^Linux \((.+)\)$/, "$1") : raw;
  const distributionId = device.distribution_id?.trim().toLowerCase();
  const distribution = distributions.find((item) => item.ids.includes(distributionId || ""))
    || distributions.find((item) => item.pattern.test(reported || ""));
  const generic = platform === "windows" ? { name: "Windows", icon: windows }
    : platform === "linux" ? { name: "Linux", icon: linux }
    : ["macos", "darwin"].includes(platform) ? { name: "macOS", icon: apple }
    : platform === "freebsd" ? { name: "FreeBSD", icon: freebsd }
    : { name: device.platform || i18n.t("unknownSystem"), icon: undefined };
  const system = platform === "linux" && distribution ? distribution : generic;
  const windowsVersion = platform === "windows" && reported?.match(/\bWindows\s+(\d+(?:\.\d+)?)\b/i);
  const name = windowsVersion ? `Windows ${windowsVersion[1]}`
    : reported && !["linux", "windows", "unknown"].includes(reported.toLowerCase())
      ? reported : system.name;
  const detail = device.kernel_version ? (
    platform === "windows" ? `Build ${device.kernel_version}` : `Kernel ${device.kernel_version}`
  ) : "";
  return { name, detail, icon: system.icon };
}

export function OperatingSystemIcon({ device, size = 14 }: { device: Device; size?: number }) {
  const { icon } = operatingSystem(device);
  // Local icons share a 24 × 24 viewBox and a single path; render with the theme color.
  const path = icon?.match(/<path d="([^"]+)"/)?.[1];
  return path ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  ) : <Monitor size={size} />;
}

export default function OperatingSystem({ device }: { device: Device }) {
  const { name, detail } = operatingSystem(device);
  return (
    <div className="device-os-cell">
      <span className="device-os-icon" aria-hidden="true">
        <OperatingSystemIcon device={device} />
      </span>
      <div className="device-os-text">
        <span className="device-os-name" title={name}>{name}</span>
        <div className="secondary-text device-os-detail">
          {device.arch && <Tag className="device-arch-tag">{device.arch}</Tag>}
          {detail && <span title={detail}>{detail}</span>}
          {!device.arch && !detail && "—"}
        </div>
      </div>
    </div>
  );
}
