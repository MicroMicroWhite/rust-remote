import type { Device, UpgradeJob } from "./types";
import i18n from "./i18n";
import { translateServerText } from "./serverText";

export const isUpgradeActive = (job?: UpgradeJob | null) =>
  !!job && ["transferring", "restarting"].includes(job.status);

export const upgradeLabelKeys: Record<string, string> = {
  transferring: "upgradeStatus.transferring", restarting: "upgradeStatus.restarting", success: "upgradeStatus.success",
  failed: "upgradeStatus.failed", timeout: "upgradeStatus.timeout", interrupted: "upgradeStatus.interrupted",
};
export const upgradeLabel = (status: string) => i18n.t(upgradeLabelKeys[status] || status);
// Kept for callers that need a snapshot; UI rendering uses upgradeLabel so language changes apply immediately.
export const upgradeLabels = Object.fromEntries(
  Object.keys(upgradeLabelKeys).map((status) => [status, upgradeLabel(status)]),
);

export function upgradeState(device: Device, job = device.upgrade?.job) {
  const upgrade = device.upgrade;
  const active = isUpgradeActive(job);
  const needsAttention = !!job && ["failed", "timeout", "interrupted"].includes(job.status);
  const available = !!upgrade?.available && device.online && !active;
  const reinstallAvailable = !!upgrade?.reinstall_available && device.online && !active;
  let manualUpdate = false;
  let label = i18n.t("upgradeNone");
  let description = translateServerText(upgrade?.reason, i18n.t.bind(i18n)) || i18n.t("fetchingVersion");
  let tone: "default" | "processing" | "warning" | "error" | "success" = "default";

  if (active) {
    label = upgradeLabel(job!.status);
    description = job!.status === "restarting"
      ? i18n.t("upgradeRestarting")
      : i18n.t("upgradeSending");
    tone = "processing";
  } else if (needsAttention) {
    label = upgradeLabel(job!.status);
    description = translateServerText(job!.detail, i18n.t.bind(i18n));
    tone = job!.status === "failed" ? "error" : "warning";
  } else if (available) {
    label = i18n.t("upgradeAvailable");
    description = i18n.t("upgradeAvailableDescription");
    tone = "warning";
  } else if (upgrade?.target_version === device.version) {
    label = i18n.t("latestVersion");
    description = reinstallAvailable ? i18n.t("reinstallDescription")
      : translateServerText(upgrade.reinstall_reason, i18n.t.bind(i18n)) || i18n.t("sameVersionDescription");
    tone = "success";
  } else if (upgrade?.reason.includes("\u624b\u52a8")) {
    manualUpdate = true;
    label = i18n.t("manualUpdate");
    description = i18n.t("manualUpdateDescription");
  } else if (!device.online && upgrade?.target_version) {
    label = i18n.t("waitingOnline");
    description = i18n.t("waitingOnlineDescription");
  } else if (upgrade?.reason.includes("\u65e0\u9700\u964d\u7ea7")) {
    label = i18n.t("newerDeviceVersion");
  } else if (upgrade?.reason.includes("\u672a\u643a\u5e26\u6b64\u7cfb\u7edf\u7684\u5347\u7ea7\u5305")) {
    description = i18n.t("noPublishedPackage");
  }
  return { label, description, tone, active, available, reinstallAvailable, needsAttention, manualUpdate };
}
