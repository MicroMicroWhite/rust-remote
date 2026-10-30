import { useState } from "react";
import { Alert, Button, Modal, Popover, Progress } from "antd";
import { ArrowRight, ArrowUpCircle, CircleAlert, CircleCheck, Info, LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "./api";
import { date } from "./format";
import { upgradeLabel, upgradeState } from "./upgrade";
import type { Device, UpgradeJob } from "./types";
import { useTranslation } from "react-i18next";
import { translateServerText } from "./serverText";

export default function DeviceUpgrade({
  device,
  compact = false,
}: {
  device: Device;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState<UpgradeJob | null>(null);
  const [error, setError] = useState("");
  const latest = device.upgrade?.job;
  const job = submitted && (!latest || submitted.updated_at > latest.updated_at)
    ? submitted : latest;
  const state = upgradeState(device, job);
  const busy = sending || state.active;
  const reinstall = !state.available && state.reinstallAvailable;
  const canSubmit = state.available || state.reinstallAvailable;
  const target = device.upgrade?.target_version;
  const actionLabel = busy
    ? sending ? t("submitting") : job?.status === "restarting" ? t("waitingReconnect") : t("transferring", { progress: job?.progress ?? 0 })
    : state.available ? t("upgradeProgram") : reinstall ? t("reinstallProgram") : t("noUpgrade");

  async function submit() {
    if (!canSubmit || sending) return;
    setSending(true);
    setError("");
    try {
      setSubmitted(await api<UpgradeJob>(
        `/devices/${encodeURIComponent(device.id)}/upgrade`, {
          method: "POST", body: JSON.stringify({ reinstall }),
        },
      ));
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const button = (
    <Button
      size={compact ? "small" : "middle"}
      type={state.available ? "primary" : "default"}
      icon={reinstall ? <RefreshCw size={14} /> : <ArrowUpCircle size={14} />}
      disabled={!canSubmit || busy}
      loading={busy}
      onClick={() => { setError(""); setConfirming(true); }}
    >
      {actionLabel}
    </Button>
  );
  const confirmation = (
    <Modal
      title={reinstall ? t("reinstallTitle") : t("upgradeTitle")}
      open={confirming}
      okText={reinstall ? t("confirmReinstall") : t("confirmUpgrade")}
      cancelText={t("cancel")}
      confirmLoading={sending}
      okButtonProps={{ disabled: !canSubmit }}
      cancelButtonProps={{ disabled: sending }}
      closable={!sending}
      keyboard={!sending}
      maskClosable={!sending}
      onCancel={() => { if (!sending) setConfirming(false); }}
      onOk={() => void submit()}
      destroyOnHidden
    >
      <p className="upgrade-device-name">{device.name}</p>
      <div className="upgrade-version-comparison">
        <div><span>{t("currentVersion")}</span><strong className="mono">{device.version}</strong></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>{t("targetVersion")}</span><strong className="mono">{target || "—"}</strong></div>
      </div>
      <p className="upgrade-confirm-note">
        {reinstall ? t("reinstallNote") : t("upgradeNote")} {t("upgradeKeepNote")}
      </p>
      {!canSubmit && !sending && <Alert showIcon type="warning" title={state.description} />}
      {error && <Alert className="upgrade-submit-error" showIcon type="error" title={t("deployFailed")} description={error} />}
    </Modal>
  );
  const details = (
    <div className="upgrade-popover">
      <p>{state.description}</p>
      <p className="secondary-text">{t("currentVersion")} {device.version} · {t("publishedVersion")} {target || t("publishedNone")}</p>
      {state.active && <Progress percent={job?.progress ?? 0} size="small"
        status="active" aria-label={t("upgradeProgress")} />}
      {job && <p className="secondary-text">{t("recentUpgrade", { status: upgradeLabel(job.status), time: date(job.updated_at) })}</p>}
      {job?.detail && <p className="secondary-text">{translateServerText(job.detail, t)}</p>}
    </div>
  );

  if (compact) return (
    <div className="upgrade-compact">
      {confirmation}
      {canSubmit || busy ? button : null}
      <Popover
        title={state.label}
        trigger={["hover", "click"]}
        content={details}
      >
        <Button type="text" size="small" className={`upgrade-info ${state.needsAttention ? "needs-attention" : ""}`}
          aria-label={t("versionStatus", { name: device.name })} icon={<Info size={14} />} />
      </Popover>
    </div>
  );
  return (
    <span className="upgrade-inline">
      {confirmation}
      <Popover title={state.label} content={details}
        trigger={canSubmit ? ["hover", "focus"] : ["hover", "click"]}>
        <Button size="small" type={state.available ? "primary" : "text"}
          className={`upgrade-status upgrade-status-${state.tone}`}
          aria-label={t("programVersion", { status: busy || canSubmit ? actionLabel : state.label })}
          aria-busy={busy}
          icon={state.active || sending ? <LoaderCircle size={13} />
            : state.available ? <ArrowUpCircle size={13} />
            : reinstall ? <RefreshCw size={13} />
            : state.tone === "success" ? <CircleCheck size={13} />
            : state.needsAttention ? <CircleAlert size={13} /> : <Info size={13} />}
          onClick={() => { if (canSubmit && !sending) { setError(""); setConfirming(true); } }}>
          {busy || canSubmit ? actionLabel : state.label}
        </Button>
      </Popover>
    </span>
  );
}
