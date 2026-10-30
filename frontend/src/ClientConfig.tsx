import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, App, Button, Descriptions, Drawer, Form, Input, Pagination,
  Popconfirm, Segmented, Space, Switch, Table, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BookOpen, Check, CheckCheck, CircleCheck,
  CircleX, Clock3, Download, Hammer, History, Link2,
  LoaderCircle, RefreshCw, Save, ShieldCheck, TerminalSquare, Trash2,
} from "lucide-react";
import { api, downloadFile } from "./api";
import { bytes, date, dateTime, relativeTime } from "./format";
import { Loading, PageHeader } from "./ui";
import { usePageLoading } from "./PageTransition";
import { useTranslation } from "react-i18next";
import { translateServerText } from "./serverText";
import "./ClientConfig.css";

type Platform = "linux" | "windows";
type Arch = "x86_64" | "aarch64";
type Connection = { server: string; allow_insecure: boolean };
type ConnectionForm = { address: string; allow_insecure: boolean; platform: Platform; arch: Arch };
const agentPath = "/agent/ws";
const connectionServer = (address: string) => address.trim().replace(/\/$/, "") + agentPath;
const connectionFields = (connection: Connection) => ({
  address: connection.server.slice(0, -agentPath.length),
  allow_insecure: connection.allow_insecure,
});
type BuildJob = Connection & {
  id: string;
  platform: Platform;
  arch: Arch;
  version: string;
  status: "queued" | "running" | "success" | "failed" | "interrupted";
  stage: string;
  detail: string;
  filename: string;
  log?: string;
  size: number | null;
  sha256: string | null;
  published: boolean;
  created_at: number;
};
type ConfigResult = {
  config: Connection | null;
  builder: { available: boolean; reason: string };
};
type TunnelStatus = {
  status: "connected" | "disconnected" | "unavailable";
  hostname: string;
  connections: number;
  protocol: string;
};
const platformName = (platform: Platform) => platform === "windows" ? "Windows" : "Linux";
const archName = (arch?: string) => arch === "aarch64" ? "aarch64" : "x86_64";
const active = (job: BuildJob) => job.status === "queued" || job.status === "running";
const pageSize = 5;

function PlatformIcon({ platform, size = 22 }: { platform: Platform; size?: number }) {
  return platform === "windows" ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2 4.5 10.5 3.3v7.9H2V4.5Zm10-1.4L22 1.7v9.5H12V3.1ZM2 12.7h8.5v7.9L2 19.4v-6.7Zm10 0h10v9.5l-10-1.4v-8.1Z" />
    </svg>
  ) : <TerminalSquare size={size} aria-hidden="true" />;
}
function JobStatus({ status, published = false, t }: { status: BuildJob["status"]; published?: boolean; t: (key: string) => string }) {
  return <span className={`cc-status cc-status-${status}`}><span />{published ? t("currentPublished") : t({ queued: "buildPreparing", running: "buildRunning", success: "buildSuccess", failed: "buildFailed", interrupted: "buildInterrupted" }[status])}</span>;
}
function BuildStages({ job, t }: { job: BuildJob; t: (key: string) => string }) {
  const stages = [
    { key: "preparing", label: t("prepareBuild") },
    { key: "compiling", label: job.platform === "windows" ? t("crossCompile") : t("compileProgram") },
    ...(job.platform === "linux" ? [{ key: "testing", label: t("runTests") }] : []),
    { key: "exporting", label: t("exportValidate") },
    { key: "complete", label: t("complete") },
  ];
  const current = job.status === "success" ? stages.length : Math.max(0, stages.findIndex((item) => item.key === job.stage));
  return <ol className="cc-stages" aria-label={t("buildStage")}>
    {stages.map((item, index) => {
      const state = index < current ? "done" : index === current ? active(job) ? "active" : "error" : "pending";
      return <li key={item.key} className={`cc-stage cc-stage-${state}`} aria-current={state === "active" ? "step" : undefined}>
        <span className="cc-stage-dot">{state === "done" ? <Check size={12} />
          : state === "active" ? <LoaderCircle size={12} className="cc-spin" />
            : state === "error" ? <CircleX size={12} /> : <span />}</span>
        <span>{item.label}</span>{state === "active" && <small>{t("inProgress")}</small>}
      </li>;
    })}
  </ol>;
}

export default function ClientConfig() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<ConnectionForm>();
  const [config, setConfig] = useState<ConfigResult | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<BuildJob | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyFilter, setHistoryFilter] = useState<"all" | Platform>("all");
  const [error, setError] = useState("");
  usePageLoading(!config && !error);
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState<"save" | "build" | "refresh" | "">("");
  const [downloading, setDownloading] = useState("");
  const [deleting, setDeleting] = useState("");
  const deletedIds = useRef(new Set<string>());
  const logRef = useRef<HTMLPreElement>(null);
  const followLog = useRef(true);
  const address = Form.useWatch("address", form) as string | undefined;
  const server = address === undefined ? undefined : connectionServer(address);
  const allowInsecure = Form.useWatch("allow_insecure", form) as boolean | undefined;
  const platform = (Form.useWatch("platform", form) || "windows") as Platform;
  const arch = (Form.useWatch("arch", form) || "x86_64") as Arch;
  const running = jobs.find(active);
  const latestJob = running || jobs[0];
  const filteredJobs = jobs.filter((job) => historyFilter === "all" || job.platform === historyFilter);
  const dirty = !!config?.config && (server?.trim() !== config.config.server || allowInsecure !== config.config.allow_insecure);

  const load = useCallback(async () => {
    setBusy("refresh");
    setError("");
    try {
      const [data, history, tunnelStatus] = await Promise.all([
        api<ConfigResult>("/client-config"), api<BuildJob[]>("/client-builds"), api<TunnelStatus>("/tunnel-status"),
      ]);
      setConfig(data);
      setTunnel(tunnelStatus);
      setJobs(history.filter((item) => !deletedIds.current.has(item.id)));
      if (!form.isFieldsTouched()) {
        form.setFieldsValue(data.config ? connectionFields(data.config) : {
          address: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`,
          allow_insecure: false, arch: "x86_64",
        });
      }
      setSelectedId((current) => current || history[0]?.id || "");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }, [form]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const history = (await api<BuildJob[]>("/client-builds")).filter((item) => !deletedIds.current.has(item.id));
        const detail = selectedId ? await api<BuildJob>(`/client-builds/${encodeURIComponent(selectedId)}`) : null;
        if (disposed) return;
        setJobs(history.filter((item) => !deletedIds.current.has(item.id)));
        if (!detail || !deletedIds.current.has(detail.id)) setSelected(detail);
        setPollError("");
        if (!selectedId && history[0]) setSelectedId(history[0].id);
      } catch (e) {
        if (!disposed) setPollError((e as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    }
    setSelected((current) => current?.id === selectedId ? current : null);
    followLog.current = true;
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [selectedId]);
  useEffect(() => {
    if (followLog.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [selected?.log, detailOpen]);
  useEffect(() => {
    setHistoryPage((current) => Math.min(current, Math.max(1, Math.ceil(filteredJobs.length / pageSize))));
  }, [filteredJobs.length]);

  async function submit(build: boolean) {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    setBusy(build ? "build" : "save");
    setError("");
    try {
      const connection = { server: connectionServer(values.address), allow_insecure: values.allow_insecure };
      if (build) {
        const job = await api<BuildJob>("/client-builds", {
          method: "POST", body: JSON.stringify({ ...connection, platform: values.platform, arch: values.arch }),
        });
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 30));
        setSelected(job);
        setSelectedId(job.id);
        setHistoryPage(1);
        setHistoryFilter("all");
        void message.success(t("buildStarted"));
      } else {
        await api<Connection>("/client-config", { method: "PUT", body: JSON.stringify(connection) });
        void message.success(t("configSaved"));
      }
      form.setFieldsValue(connectionFields(connection));
      setConfig((current) => current ? { ...current, config: connection } : current);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }
  async function download(job: BuildJob) {
    setDownloading(job.id);
    try { await downloadFile(`/client-builds/${encodeURIComponent(job.id)}/download`, job.filename); }
    catch (e) { void message.error((e as Error).message); }
    finally { setDownloading(""); }
  }
  async function deleteJob(job: BuildJob) {
    setDeleting(job.id);
    try {
      const result = await api<{ deleted_ids: string[] }>(`/client-builds/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      result.deleted_ids.forEach((id) => deletedIds.current.add(id));
      const remaining = jobs.filter((item) => !deletedIds.current.has(item.id));
      setJobs(remaining);
      if (deletedIds.current.has(selectedId)) {
        setDetailOpen(false);
        setSelected(null);
        setSelectedId(remaining[0]?.id || "");
      }
      void message.success(t("recordsDeleted"));
    } catch (e) { void message.error((e as Error).message); }
    finally { setDeleting(""); }
  }
  const deleteAction = (job: BuildJob) => <Popconfirm title={t("deleteBuild")}
    description={<div className="cc-delete-description">{t("deleteBuildNote")}
      {job.published && <p>{t("publishedDeleteNote")}</p>}</div>}
    onConfirm={() => deleteJob(job)} okText={t("confirmDelete")} cancelText={t("cancel")} okButtonProps={{ danger: true }}
    disabled={active(job) || !!deleting || !!downloading}>
    <Button danger size="small" type="text" icon={<Trash2 size={14} />} aria-label={`${t("delete")} ${platformName(job.platform)} v${job.version}`}
      title={active(job) ? t("deleteAfterBuild") : t("deleteBuild")}
      loading={deleting === job.id} disabled={active(job) || !!deleting || !!downloading}>{t("delete")}</Button>
  </Popconfirm>;
  function showDetails(job: BuildJob) {
    if (job.id !== selectedId) setSelected(null);
    setSelectedId(job.id);
    setDetailOpen(true);
  }
  const historyActions = (job: BuildJob) => <div className="cc-record-actions">
    <Tooltip title={t("buildDetails")}><Button size="small" type="text" icon={<TerminalSquare size={15} />} aria-label={`${t("buildDetails")} ${platformName(job.platform)} v${job.version}`} onClick={() => showDetails(job)} /></Tooltip>
    <Button size="small" icon={<Download size={14} />} disabled={job.status !== "success" || !!downloading || !!deleting}
      loading={downloading === job.id} onClick={() => void download(job)}>{t("download")}</Button>
    {deleteAction(job)}
  </div>;
  const columns: ColumnsType<BuildJob> = [
    { title: t("programVersion"), key: "platform", width: 175, render: (_, job) => <div className="cc-record-file">
      <span className={`cc-os-icon cc-os-${job.platform}`}><PlatformIcon platform={job.platform} size={18} /></span>
      <div><strong>{platformName(job.platform)} <small>{archName(job.arch)}</small></strong><span>v{job.version}</span></div>
    </div> },
    { title: t("connectionAddress"), dataIndex: "server", ellipsis: true, render: (value: string) => <span className="cc-record-server">{value}</span> },
    { title: t("programSize"), dataIndex: "size", width: 115, align: "right",
      render: (value: number | null) => value == null ? "—" : <Tooltip title={`${value.toLocaleString()} ${t("bytes")}`}><span>{bytes(value)}</span></Tooltip> },
    { title: t("status"), dataIndex: "status", width: 110, render: (value: BuildJob["status"], job) => <JobStatus status={value} published={job.published} t={t} /> },
    { title: t("createdAt"), dataIndex: "created_at", width: 170, render: (value: number) => <Tooltip title={dateTime(value)}><span className="cc-record-date">{dateTime(value)}</span></Tooltip> },
    { title: "", key: "actions", width: 185, align: "right", render: (_, job) => historyActions(job) },
  ];

  return <div className="client-config-page">
    <PageHeader title={t("clientConfigTitle")}
      extra={<div className="cc-header-actions">
        {config && <span className={`cc-environment ${config.builder.available ? "is-ready" : ""}`}>
          <span />{config.builder.available ? t("buildEnvironmentReady") : t("environmentNotReady")}
        </span>}
        <Space size={6}>
          <Button type="text" icon={<BookOpen size={15} />} onClick={() => setGuideOpen(true)}>{t("deploymentGuide")}</Button>
          <Tooltip title={t("refreshBuildEnvironment")}><Button aria-label={t("refreshBuildEnvironment")} icon={<RefreshCw size={15} />}
            loading={busy === "refresh"} disabled={!!busy} onClick={() => void load()} /></Tooltip>
        </Space>
      </div>} />
    {error && <Alert className="page-alert" type="error" showIcon title={t("operationFailed")} description={error} />}
    {pollError && <Alert className="page-alert" type="warning" showIcon title={t("buildSyncRetry")} description={pollError} />}
    {!config ? (busy ? <Loading /> : <Button onClick={() => void load()}>{t("reload")}</Button>) : <>
      {!config.builder.available && <Alert className="page-alert" type="warning" showIcon title={t("builderNotReady")} description={translateServerText(config.builder.reason, t)} />}
      <div className="cc-status-grid">
        {tunnel && <section className={`cc-status-card cc-tunnel cc-tunnel-${tunnel.status}`} aria-label={t("tunnelStatus")}>
          <div className="cc-status-card-heading"><span className="cc-tunnel-dot" /><strong>Cloudflare Tunnel</strong>
            <span className="cc-status-label">{tunnel.status === "connected" ? t("connectedStatus") : tunnel.status === "disconnected" ? t("disconnectedStatus") : t("unavailableStatus")}</span></div>
          <div className="cc-status-card-meta"><span>{tunnel.hostname || t("domainNotConfigured")}</span><span>{tunnel.connections} {t("connectors")} · {tunnel.protocol}</span></div>
        </section>}
        {latestJob && <section className={`cc-status-card cc-build-card cc-build-${latestJob.status}`} aria-label={t("latestBuild")} aria-live="polite">
          <div className="cc-status-card-heading"><span className="cc-build-symbol">{active(latestJob) ? <LoaderCircle size={16} className="cc-spin" />
            : latestJob.status === "success" ? <CircleCheck size={16} /> : <CircleX size={16} />}</span>
            <strong>{active(latestJob) ? t("generatingProgram", { platform: platformName(latestJob.platform) })
              : latestJob.status === "success" ? `${platformName(latestJob.platform)} ${latestJob.published ? t("publishedLatest") : t("readyStatus")}`
                : latestJob.status === "interrupted" ? t("lastBuildInterrupted") : t("lastBuildFailed")}</strong></div>
          <div className="cc-status-card-meta"><span>v{latestJob.version} · {active(latestJob) ? t("backgroundBuild") : relativeTime(latestJob.created_at)}</span>
            <span className="cc-status-card-actions"><Button type="text" size="small" icon={<TerminalSquare size={14} />} onClick={() => showDetails(latestJob)}>{t("logs")}</Button>
              {latestJob.status === "success" && <Button size="small" icon={<Download size={14} />} disabled={!!downloading || !!deleting}
                loading={downloading === latestJob.id} onClick={() => void download(latestJob)}>{t("download")}</Button>}</span></div>
          {latestJob.status === "success" && latestJob.published && <div className="cc-status-card-note">{t("compilePublishedNotice")}</div>}
        </section>}
      </div>
      <section className="cc-setup" aria-labelledby="cc-connection-title">
        <header className="cc-setup-heading">
          <div><h2 id="cc-connection-title">{t("generateProgram")}</h2><span className="cc-architecture">{arch}</span></div>
          <span className={`cc-save-state ${dirty ? "is-dirty" : ""}`}>
            {dirty ? <span className="cc-unsaved-dot" /> : <CheckCheck size={14} />}
            {dirty ? t("changedConfig") : config.config ? t("savedConfig") : t("unsavedConfig")}
          </span>
        </header>
        <Form form={form} layout="vertical" initialValues={{ platform: "windows", arch: "x86_64", allow_insecure: false }}
          requiredMark={false} disabled={!!busy} className="cc-form">
          <div className="cc-setting-row">
            <div className="cc-setting-label"><label id="cc-platform-label">{t("runSystem")}</label><span>{t("systemUsedByDevice")}</span></div>
            <div className="cc-setting-control">
              <Form.Item name="platform" className="cc-platform-field">
                <Segmented aria-labelledby="cc-platform-label" className="cc-platform-options" options={[
                  { value: "windows", label: "Windows", icon: <PlatformIcon platform="windows" size={17} /> },
                  { value: "linux", label: "Linux", icon: <PlatformIcon platform="linux" size={17} /> },
                ]} />
              </Form.Item>
              <span className="cc-requirements">{platform === "windows" ? `Windows 10 / Server 2016+ · ${arch}` : `glibc 2.36+ · ${arch}`}</span>
              <Form.Item name="arch" className="cc-platform-field">
                <Segmented aria-label={t("targetArchitecture")} options={[{ value: "x86_64", label: "x86_64" }, { value: "aarch64", label: "aarch64" }]} />
              </Form.Item>
            </div>
          </div>
          <div className="cc-setting-row">
            <div className="cc-setting-label"><label htmlFor="address">{t("controllerAddress")}</label><span>{t("deviceConnectsHere")}</span></div>
            <div className="cc-setting-control cc-address-control">
              <Form.Item name="address" className="cc-address-field" rules={[
                { required: true, message: t("requiredControllerAddress") },
                { validator: async (_, raw: string) => {
                  try {
                    const value = raw.trim();
                    const url = new URL(value);
                    if (!/^wss?:\/\/[^/?#]+\/?$/.test(value) || !url.hostname || url.port === "0" || url.pathname !== "/"
                      || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f\\]/.test(value)) throw new Error();
                  } catch { throw new Error(t("invalidControllerAddress")); }
                } },
              ]}>
                <Input prefix={<Link2 size={16} />} placeholder="wss://remote.example.com" autoComplete="off"
                  suffix={<Tooltip title={t("fixedPath")}><span className="cc-address-path">{agentPath}</span></Tooltip>} />
              </Form.Item>
            </div>
          </div>
          <div className="cc-setting-row cc-security-setting">
            <div className="cc-setting-label"><label htmlFor="allow_insecure">{t("connectionSecurity")}</label><span>{t("publicWssHint")}</span></div>
            <div className="cc-security-control">
              <div className="cc-security-switch">
                <Form.Item name="allow_insecure" valuePropName="checked" dependencies={["address"]}
                  rules={[{ validator: async (_, value: boolean) => {
                    if (form.getFieldValue("address")?.trim().toLowerCase().startsWith("ws://") && !value)
                      throw new Error(t("invalidControllerAddress"));
                  } }]}><Switch aria-label={t("allowInsecure")} size="small" /></Form.Item>
                <label htmlFor="allow_insecure">{t("allowInsecure")}</label>
              </div>
              {allowInsecure && <span className="cc-security-note">{t("trustedNetworkOnly")}</span>}
            </div>
          </div>
          <footer className="cc-form-footer">
            <span className="cc-key-note"><ShieldCheck size={15} />{t("keyBuiltIn")}</span>
            <div className="cc-form-actions">
              <Button type="text" icon={<Save size={15} />} loading={busy === "save"} onClick={() => void submit(false)}>{t("saveConfig")}</Button>
              <Button type="primary" icon={<Hammer size={15} />} loading={busy === "build"}
                disabled={!config.builder.available || !!running} onClick={() => void submit(true)}>
                {running ? t("compiling") : t("generateClient", { platform: platformName(platform) })}
              </Button>
            </div>
          </footer>
        </Form>
      </section>
      <section className="cc-history-panel" aria-labelledby="cc-history-title">
        <div className="cc-history-heading"><div><h2 id="cc-history-title">{t("programsVersions")}</h2><span className="cc-count">{jobs.length}</span></div>
          <span className="cc-history-refresh"><span className={pollError ? "" : "is-live"} />{pollError ? t("syncInterrupted") : t("realtimeSync")}</span>
        </div>
        <div className="cc-history-toolbar"><Segmented value={historyFilter} aria-label={t("buildDetails")} onChange={(value) => { setHistoryFilter(value as "all" | Platform); setHistoryPage(1); }}
          options={[{ value: "all", label: t("all") }, { value: "windows", label: "Windows", icon: <PlatformIcon platform="windows" size={13} /> }, { value: "linux", label: "Linux", icon: <PlatformIcon platform="linux" size={14} /> }]} />
          <span>{t("recentBuilds")}</span></div>
        {filteredJobs.length ? <>
          <div className="cc-history-desktop"><Table<BuildJob> rowKey="id" columns={columns} dataSource={filteredJobs} size="middle"
            pagination={{ current: historyPage, pageSize, onChange: setHistoryPage, hideOnSinglePage: true, showSizeChanger: false }}
            rowClassName={(job) => job.id === selectedId ? "cc-record-selected" : ""} tableLayout="fixed" /></div>
          <div className="cc-history-mobile">
            {filteredJobs.slice((historyPage - 1) * pageSize, historyPage * pageSize).map((job) => <article key={job.id} className="cc-mobile-record">
              <div><div className="cc-record-file"><span className={`cc-os-icon cc-os-${job.platform}`}><PlatformIcon platform={job.platform} size={17} /></span>
                <strong>{platformName(job.platform)} <small>v{job.version} · {archName(job.arch)}</small></strong></div><JobStatus status={job.status} published={job.published} t={t} /></div>
              <p title={job.server}>{job.server}</p>
              <div><span className="cc-record-date">{relativeTime(job.created_at)} · ${t("programSize")}: {job.size == null ? "—" : bytes(job.size)}</span>{historyActions(job)}</div>
            </article>)}
            {filteredJobs.length > pageSize && <Pagination current={historyPage} pageSize={pageSize} total={filteredJobs.length} onChange={setHistoryPage} simple />}
          </div>
        </> : <div className="cc-history-empty"><span><History size={21} strokeWidth={1.5} /></span><div><strong>{historyFilter === "all" ? t("noBuildRecords") : t("noPlatformBuildRecords", { platform: platformName(historyFilter) })}</strong><p>{t("noDownloadableProgram")}</p></div></div>}
      </section>
      <p className="cc-page-note"><ShieldCheck size={13} />{t("clientSecurityNote")}</p>
    </>}
    <Drawer open={detailOpen} onClose={() => setDetailOpen(false)} title={t("buildDetail")} size={680} className="cc-detail-drawer"
      afterOpenChange={(open) => { if (open && logRef.current && followLog.current) logRef.current.scrollTop = logRef.current.scrollHeight; }}>
      {selected ? <>
        <div className="cc-drawer-file"><div className="cc-record-file"><span className={`cc-os-icon cc-os-${selected.platform}`}><PlatformIcon platform={selected.platform} /></span>
          <div><strong>{platformName(selected.platform)} {archName(selected.arch)}</strong><span>v{selected.version} · {selected.filename}</span></div></div><JobStatus status={selected.status} published={selected.published} t={t} /></div>
        <p className="cc-drawer-detail">{translateServerText(selected.detail, t)}</p><BuildStages job={selected} t={t} />
        <Descriptions size="small" column={1} items={[
          { key: "server", label: t("connectionAddress"), children: selected.server },
          { key: "created", label: t("createdAt"), children: date(selected.created_at) },
          { key: "insecure", label: t("connectionMethod"), children: selected.allow_insecure ? t("allowWs") : t("onlyWss") },
          ...(selected.size ? [{ key: "size", label: t("fileSize"), children: bytes(selected.size) }] : []),
          ...(selected.sha256 ? [{ key: "sha256", label: "SHA-256", children: <Typography.Text className="mono cc-checksum" copyable>{selected.sha256}</Typography.Text> }] : []),
        ]} />
        <div className="cc-log-heading"><TerminalSquare size={15} /><h3>{t("buildLog")}</h3><span>{t("last64KiB")}</span></div>
        <pre ref={logRef} className="cc-log" tabIndex={0} aria-label={t("buildLog")}
          onScroll={(event) => { const el = event.currentTarget; followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {selected.log || t("waitingBuildLog")}
        </pre>
        {selected.status === "success" && <Button type="primary" icon={<Download size={15} />} className="cc-drawer-download"
          disabled={!!downloading} loading={downloading === selected.id} onClick={() => void download(selected)}>{t("downloadClient")}</Button>}
        <div className="cc-drawer-delete">{deleteAction(selected)}</div>
      </> : <Loading />}
    </Drawer>
    <Drawer open={guideOpen} onClose={() => setGuideOpen(false)} title={t("usageGuide")} size={480} className="cc-guide-drawer">
      <section><span className="cc-guide-icon"><Link2 size={19} /></span><h3>{t("guideConnect")}</h3><p>{t("guideConnectText")}</p></section>
      <section><span className="cc-guide-icon"><PlatformIcon platform="windows" size={19} /></span><h3>{t("guideWindows")}</h3><p>{t("guideWindowsText")}</p></section>
      <section><span className="cc-guide-icon"><PlatformIcon platform="linux" size={19} /></span><h3>{t("guideLinux")}</h3><p>{t("guideLinuxText")}</p><pre>chmod +x rust-remote-client{"\n"}./rust-remote-client</pre><p>{t("guideLinuxRunText")}</p></section>
      <section><span className="cc-guide-icon"><Clock3 size={19} /></span><h3>{t("guideBuild")}</h3><p>{t("guideBuildText")}</p><p>{t("guideUpdateText")}</p></section>
    </Drawer>
  </div>;
}
