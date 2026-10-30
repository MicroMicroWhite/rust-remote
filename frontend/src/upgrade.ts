import type { Device, UpgradeJob } from "./types";

export const isUpgradeActive = (job?: UpgradeJob | null) =>
  !!job && ["transferring", "restarting"].includes(job.status);

export const upgradeLabels: Record<string, string> = {
  transferring: "正在传输",
  restarting: "等待重连",
  success: "升级成功",
  failed: "升级失败",
  timeout: "结果待确认",
  interrupted: "升级已中断",
};

export function upgradeState(device: Device, job = device.upgrade?.job) {
  const upgrade = device.upgrade;
  const active = isUpgradeActive(job);
  const needsAttention = !!job && ["failed", "timeout", "interrupted"].includes(job.status);
  const available = !!upgrade?.available && device.online && !active;
  const reinstallAvailable = !!upgrade?.reinstall_available && device.online && !active;
  let label = "暂无发布版本";
  let description = upgrade?.reason || "正在获取版本信息。";
  let tone: "default" | "processing" | "warning" | "error" | "success" = "default";

  if (active) {
    label = upgradeLabels[job!.status];
    description = job!.status === "restarting"
      ? "安装包已传输完成，正在等待新版本重新上线。"
      : "正在发送升级包，可继续浏览页面或稍后回来查看结果。";
    tone = "processing";
  } else if (needsAttention) {
    label = upgradeLabels[job!.status];
    description = job!.detail;
    tone = job!.status === "failed" ? "error" : "warning";
  } else if (available) {
    label = "可在线升级";
    description = "有适用于此设备的新版本，升级时会短暂离线。";
    tone = "warning";
  } else if (upgrade?.target_version === device.version) {
    label = "已是最新版";
    description = reinstallAvailable ? "版本号与已发布版本一致，可手动重新下发并安装程序。"
      : upgrade.reinstall_reason || "版本号与已发布版本一致。";
    tone = "success";
  } else if (upgrade?.reason.includes("手动")) {
    label = "需手动更新";
    description = "此版本需先手动更新一次，之后即可使用在线升级。";
  } else if (!device.online && upgrade?.target_version) {
    label = "等待上线";
    description = "设备上线后将自动检查是否可以升级。";
  } else if (upgrade?.reason.includes("无需降级")) {
    label = "设备版本较新";
  } else if (upgrade?.reason.includes("未携带此系统的升级包")) {
    description = "控制端暂无适用于此设备的发布包。";
  }
  return { label, description, tone, active, available, reinstallAvailable, needsAttention };
}
