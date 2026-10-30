import { describe, expect, test } from "bun:test";
import { upgradeState } from "../src/upgrade";
import type { Device } from "../src/types";

const device: Device = {
  id: "device-1", name: "测试设备", platform: "linux", arch: "x86_64", version: "0.3.3",
  online: true, last_seen: 1, source_ip: null, local_addresses: [], public_ip: null,
  public_ip_source: null, reported_at: null,
  upgrade: { available: false, reinstall_available: true, target_version: "0.3.3", reason: "已是控制端携带版本", job: null },
};

describe("same version redistribution", () => {
  test("latest version keeps its status and offers redistribution", () => {
    expect(upgradeState(device)).toMatchObject({ label: "已是最新版", available: false, reinstallAvailable: true });
  });
  test("offline and active transfers cannot be submitted again", () => {
    expect(upgradeState({ ...device, online: false }).reinstallAvailable).toBe(false);
    expect(upgradeState(device, {
      id: "update", target_version: "0.3.3", status: "restarting", progress: 100, detail: "", updated_at: 1,
    })).toMatchObject({ active: true, reinstallAvailable: false });
  });
  test("legacy clients explain why same version redistribution is unavailable", () => {
    const state = upgradeState({ ...device, upgrade: {
      ...device.upgrade!, reinstall_available: false, reinstall_reason: "请先升级被控端",
    } });
    expect(state.reinstallAvailable).toBe(false);
    expect(state.description).toBe("请先升级被控端");
  });
  test("newer releases retain the normal upgrade action", () => {
    expect(upgradeState({ ...device, version: "0.3.2", upgrade: {
      ...device.upgrade!, available: true, reinstall_available: false,
    } })).toMatchObject({ available: true, reinstallAvailable: false, label: "可在线升级" });
  });
});
