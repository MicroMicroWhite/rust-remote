import { useState } from "react";
import { Alert, Button, Modal, Popover, Progress } from "antd";
import { ArrowRight, ArrowUpCircle, CircleAlert, CircleCheck, Info, LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "./api";
import { date } from "./format";
import { upgradeLabels, upgradeState } from "./upgrade";
import type { Device, UpgradeJob } from "./types";

export default function DeviceUpgrade({
  device,
  compact = false,
}: {
  device: Device;
  compact?: boolean;
}) {
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
    ? sending ? "正在提交" : job?.status === "restarting" ? "等待重连" : `传输中 ${job?.progress ?? 0}%`
    : state.available ? "升级程序" : reinstall ? "重新下发" : "暂无可用升级";

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
      title={reinstall ? "重新下发被控端程序" : "升级被控端程序"}
      open={confirming}
      okText={reinstall ? "确认重新下发" : "确认升级"}
      cancelText="取消"
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
        <div><span>当前版本</span><strong className="mono">{device.version}</strong></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>目标版本</span><strong className="mono">{target || "—"}</strong></div>
      </div>
      <p className="upgrade-confirm-note">
        {reinstall ? "将重新传输并安装已发布的同版本程序，设备会短暂离线。" : "升级期间设备会短暂离线。"}
        连接配置和设备身份会保留；连接失败时会尝试恢复旧程序。
      </p>
      {!canSubmit && !sending && <Alert showIcon type="warning" title={state.description} />}
      {error && <Alert className="upgrade-submit-error" showIcon type="error" title="未能下发程序" description={error} />}
    </Modal>
  );
  const details = (
    <div className="upgrade-popover">
      <p>{state.description}</p>
      <p className="secondary-text">当前 {device.version} · 发布 {target || "暂无"}</p>
      {state.active && <Progress percent={job?.progress ?? 0} size="small"
        status="active" aria-label="升级包传输进度" />}
      {job && <p className="secondary-text">最近升级：{upgradeLabels[job.status] || job.status} · {date(job.updated_at)}</p>}
      {job?.detail && <p className="secondary-text">{job.detail}</p>}
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
          aria-label={`查看 ${device.name} 的版本状态`} icon={<Info size={14} />} />
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
          aria-label={`程序版本：${busy || canSubmit ? actionLabel : state.label}`}
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
