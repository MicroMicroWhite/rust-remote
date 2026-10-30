import type { IdentityInfo } from "./RuntimeIdentity";

export type Device = {
  id: string;
  name: string;
  platform: string;
  os?: string | null;
  distribution_id?: string | null;
  kernel_version?: string | null;
  arch: string;
  version: string;
  last_seen: number;
  online: boolean;
  capabilities?: string[];
  source_ip: string | null;
  local_addresses: { interface: string; address: string }[];
  public_ip: string | null;
  public_ip_source: string | null;
  reported_at: number | null;
  upgrade?: {
    available: boolean;
    reinstall_available?: boolean;
    reinstall_reason?: string;
    target_version: string | null;
    reason: string;
    job: UpgradeJob | null;
  };
};
export type UpgradeJob = {
  id: string;
  target_version: string;
  status: string;
  progress: number;
  detail: string;
  updated_at: number;
};
export type Info = {
  hostname: string;
  os: string;
  distribution_id?: string | null;
  kernel_version?: string | null;
  arch: string;
  cpu_count: number;
  cpu_usage?: number;
  memory_total: number;
  memory_used: number;
  network_received?: number;
  network_transmitted?: number;
  disk_read?: number;
  disk_written?: number;
  uptime: number;
  default_path: string;
  shell_enabled: boolean;
  runtime_identity?: IdentityInfo;
  local_addresses?: { interface: string; address: string }[];
  public_ip?: string | null;
};
export type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number | null;
};
export type Listing = {
  path: string;
  parent: string | null;
  entries: Entry[];
  truncated: boolean;
};
export type Process = {
  pid: number;
  name: string;
  memory: number;
  status: string;
  start_time?: number;
  can_kill?: boolean;
};
export type EnvironmentVariable = {
  name: string;
  value: string;
};
export type Output = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  truncated: boolean;
};
