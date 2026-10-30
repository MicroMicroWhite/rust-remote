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
import { bytes, date, relativeTime } from "./format";
import { Loading, PageHeader } from "./ui";
import { usePageLoading } from "./PageTransition";
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
const statuses = {
  queued: "准备中", running: "编译中", success: "已完成", failed: "编译失败", interrupted: "已中断",
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
function JobStatus({ status, published = false }: { status: BuildJob["status"]; published?: boolean }) {
  return <span className={`cc-status cc-status-${status}`}><span />{published ? "当前发布" : statuses[status]}</span>;
}
function BuildStages({ job }: { job: BuildJob }) {
  const stages = [
    { key: "preparing", label: "准备编译环境" },
    { key: "compiling", label: job.platform === "windows" ? "交叉编译程序" : "编译程序" },
    ...(job.platform === "linux" ? [{ key: "testing", label: "运行测试" }] : []),
    { key: "exporting", label: "导出与校验" },
    { key: "complete", label: "完成" },
  ];
  const current = job.status === "success" ? stages.length : Math.max(0, stages.findIndex((item) => item.key === job.stage));
  return <ol className="cc-stages" aria-label="编译阶段">
    {stages.map((item, index) => {
      const state = index < current ? "done" : index === current ? active(job) ? "active" : "error" : "pending";
      return <li key={item.key} className={`cc-stage cc-stage-${state}`} aria-current={state === "active" ? "step" : undefined}>
        <span className="cc-stage-dot">{state === "done" ? <Check size={12} />
          : state === "active" ? <LoaderCircle size={12} className="cc-spin" />
            : state === "error" ? <CircleX size={12} /> : <span />}</span>
        <span>{item.label}</span>{state === "active" && <small>进行中</small>}
      </li>;
    })}
  </ol>;
}

export default function ClientConfig() {
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
        void message.success("编译已开始，成功后自动发布，关闭页面后仍会继续。");
      } else {
        await api<Connection>("/client-config", { method: "PUT", body: JSON.stringify(connection) });
        void message.success("连接配置已保存");
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
      void message.success("编译记录及产物已删除");
    } catch (e) { void message.error((e as Error).message); }
    finally { setDeleting(""); }
  }
  const deleteAction = (job: BuildJob) => <Popconfirm title="删除编译记录及产物？"
    description={<div className="cc-delete-description">相同程序的合并记录及文件将一并删除，删除后无法恢复。
      {job.published && <p>此程序已发布，删除后将取消该系统的当前发布版本。</p>}</div>}
    onConfirm={() => deleteJob(job)} okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }}
    disabled={active(job) || !!deleting || !!downloading}>
    <Button danger size="small" type="text" icon={<Trash2 size={14} />} aria-label={`删除 ${platformName(job.platform)} v${job.version} 编译记录`}
      title={active(job) ? "编译结束后可删除" : "删除编译记录及产物"}
      loading={deleting === job.id} disabled={active(job) || !!deleting || !!downloading}>删除</Button>
  </Popconfirm>;
  function showDetails(job: BuildJob) {
    if (job.id !== selectedId) setSelected(null);
    setSelectedId(job.id);
    setDetailOpen(true);
  }
  const historyActions = (job: BuildJob) => <div className="cc-record-actions">
    <Tooltip title="查看编译详情"><Button size="small" type="text" icon={<TerminalSquare size={15} />} aria-label={`查看 ${platformName(job.platform)} v${job.version} 编译详情`} onClick={() => showDetails(job)} /></Tooltip>
    <Button size="small" icon={<Download size={14} />} disabled={job.status !== "success" || !!downloading || !!deleting}
      loading={downloading === job.id} onClick={() => void download(job)}>下载</Button>
    {deleteAction(job)}
  </div>;
  const columns: ColumnsType<BuildJob> = [
    { title: "程序 / 版本", key: "platform", width: 175, render: (_, job) => <div className="cc-record-file">
      <span className={`cc-os-icon cc-os-${job.platform}`}><PlatformIcon platform={job.platform} size={18} /></span>
      <div><strong>{platformName(job.platform)} <small>{archName(job.arch)}</small></strong><span>v{job.version}</span></div>
    </div> },
    { title: "连接地址", dataIndex: "server", ellipsis: true, render: (value: string) => <span className="cc-record-server">{value}</span> },
    { title: "程序大小", dataIndex: "size", width: 115, align: "right",
      render: (value: number | null) => value == null ? "—" : <Tooltip title={`${value.toLocaleString()} 字节`}><span>{bytes(value)}</span></Tooltip> },
    { title: "状态", dataIndex: "status", width: 110, render: (value: BuildJob["status"], job) => <JobStatus status={value} published={job.published} /> },
    { title: "创建时间", dataIndex: "created_at", width: 130, render: (value: number) => <Tooltip title={date(value)}><span className="cc-record-date">{relativeTime(value)}</span></Tooltip> },
    { title: "", key: "actions", width: 185, align: "right", render: (_, job) => historyActions(job) },
  ];

  return <div className="client-config-page">
    <PageHeader title="被控端配置"
      extra={<div className="cc-header-actions">
        {config && <span className={`cc-environment ${config.builder.available ? "is-ready" : ""}`}>
          <span />{config.builder.available ? "编译环境可用" : "环境未就绪"}
        </span>}
        <Space size={6}>
          <Button type="text" icon={<BookOpen size={15} />} onClick={() => setGuideOpen(true)}>部署指南</Button>
          <Tooltip title="刷新编译环境"><Button aria-label="刷新编译环境" icon={<RefreshCw size={15} />}
            loading={busy === "refresh"} disabled={!!busy} onClick={() => void load()} /></Tooltip>
        </Space>
      </div>} />
    {error && <Alert className="page-alert" type="error" showIcon title="操作失败" description={error} />}
    {pollError && <Alert className="page-alert" type="warning" showIcon title="进度同步失败，正在重试" description={pollError} />}
    {!config ? (busy ? <Loading /> : <Button onClick={() => void load()}>重新加载</Button>) : <>
      {!config.builder.available && <Alert className="page-alert" type="warning" showIcon title="编译环境尚未就绪" description={config.builder.reason} />}
      <div className="cc-status-grid">
        {tunnel && <section className={`cc-status-card cc-tunnel cc-tunnel-${tunnel.status}`} aria-label="Cloudflare Tunnel 状态">
          <div className="cc-status-card-heading"><span className="cc-tunnel-dot" /><strong>Cloudflare Tunnel</strong>
            <span className="cc-status-label">{tunnel.status === "connected" ? "已连接" : tunnel.status === "disconnected" ? "已断开" : "状态不可用"}</span></div>
          <div className="cc-status-card-meta"><span>{tunnel.hostname || "未配置域名"}</span><span>{tunnel.connections} 个连接器 · {tunnel.protocol}</span></div>
        </section>}
        {latestJob && <section className={`cc-status-card cc-build-card cc-build-${latestJob.status}`} aria-label="最近编译任务" aria-live="polite">
          <div className="cc-status-card-heading"><span className="cc-build-symbol">{active(latestJob) ? <LoaderCircle size={16} className="cc-spin" />
            : latestJob.status === "success" ? <CircleCheck size={16} /> : <CircleX size={16} />}</span>
            <strong>{active(latestJob) ? `正在生成 ${platformName(latestJob.platform)} 程序`
              : latestJob.status === "success" ? `${platformName(latestJob.platform)} 程序${latestJob.published ? "已发布为最新版本" : "已就绪"}`
                : latestJob.status === "interrupted" ? "上次编译已中断" : "上次编译未成功"}</strong></div>
          <div className="cc-status-card-meta"><span>v{latestJob.version} · {active(latestJob) ? "后台编译中" : relativeTime(latestJob.created_at)}</span>
            <span className="cc-status-card-actions"><Button type="text" size="small" icon={<TerminalSquare size={14} />} onClick={() => showDetails(latestJob)}>日志</Button>
              {latestJob.status === "success" && <Button size="small" icon={<Download size={14} />} disabled={!!downloading || !!deleting}
                loading={downloading === latestJob.id} onClick={() => void download(latestJob)}>下载</Button>}</span></div>
        </section>}
      </div>
      <section className="cc-setup" aria-labelledby="cc-connection-title">
        <header className="cc-setup-heading">
          <div><h2 id="cc-connection-title">生成新程序</h2><span className="cc-architecture">{arch}</span></div>
          <span className={`cc-save-state ${dirty ? "is-dirty" : ""}`}>
            {dirty ? <span className="cc-unsaved-dot" /> : <CheckCheck size={14} />}
            {dirty ? "配置有更改" : config.config ? "配置已保存" : "尚未保存配置"}
          </span>
        </header>
        <Form form={form} layout="vertical" initialValues={{ platform: "windows", arch: "x86_64", allow_insecure: false }}
          requiredMark={false} disabled={!!busy} className="cc-form">
          <div className="cc-setting-row">
            <div className="cc-setting-label"><label id="cc-platform-label">运行系统</label><span>被控设备使用的操作系统</span></div>
            <div className="cc-setting-control">
              <Form.Item name="platform" className="cc-platform-field">
                <Segmented aria-labelledby="cc-platform-label" className="cc-platform-options" options={[
                  { value: "windows", label: "Windows", icon: <PlatformIcon platform="windows" size={17} /> },
                  { value: "linux", label: "Linux", icon: <PlatformIcon platform="linux" size={17} /> },
                ]} />
              </Form.Item>
              <span className="cc-requirements">{platform === "windows" ? `Windows 10 / Server 2016 及以上 · ${arch}` : `glibc 2.36+ · ${arch}`}</span>
              <Form.Item name="arch" className="cc-platform-field">
                <Segmented aria-label="目标架构" options={[{ value: "x86_64", label: "x86_64" }, { value: "aarch64", label: "aarch64" }]} />
              </Form.Item>
            </div>
          </div>
          <div className="cc-setting-row">
            <div className="cc-setting-label"><label htmlFor="address">主控地址</label><span>被控设备连接到此服务器</span></div>
            <div className="cc-setting-control cc-address-control">
              <Form.Item name="address" className="cc-address-field" rules={[
                { required: true, message: "请输入主控连接地址" },
                { validator: async (_, raw: string) => {
                  try {
                    const value = raw.trim();
                    const url = new URL(value);
                    if (!/^wss?:\/\/[^/?#]+\/?$/.test(value) || !url.hostname || url.port === "0" || url.pathname !== "/"
                      || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f\\]/.test(value)) throw new Error();
                  } catch { throw new Error("请输入 ws:// 或 wss://主机[:端口]，无需填写路径"); }
                } },
              ]}>
                <Input prefix={<Link2 size={16} />} placeholder="wss://remote.example.com" autoComplete="off"
                  suffix={<Tooltip title="固定连接路径，自动添加"><span className="cc-address-path">{agentPath}</span></Tooltip>} />
              </Form.Item>
            </div>
          </div>
          <div className="cc-setting-row cc-security-setting">
            <div className="cc-setting-label"><label htmlFor="allow_insecure">连接安全</label><span>公网连接建议使用 wss://</span></div>
            <div className="cc-security-control">
              <div className="cc-security-switch">
                <Form.Item name="allow_insecure" valuePropName="checked" dependencies={["address"]}
                  rules={[{ validator: async (_, value: boolean) => {
                    if (form.getFieldValue("address")?.trim().toLowerCase().startsWith("ws://") && !value)
                      throw new Error("ws:// 地址需要允许明文连接，或将地址改为 wss://");
                  } }]}><Switch aria-label="允许内网明文连接" size="small" /></Form.Item>
                <label htmlFor="allow_insecure">允许内网明文连接</label>
              </div>
              {allowInsecure && <span className="cc-security-note">仅用于可信内网</span>}
            </div>
          </div>
          <footer className="cc-form-footer">
            <span className="cc-key-note"><ShieldCheck size={15} />设备密钥自动内置</span>
            <div className="cc-form-actions">
              <Button type="text" icon={<Save size={15} />} loading={busy === "save"} onClick={() => void submit(false)}>保存配置</Button>
              <Button type="primary" icon={<Hammer size={15} />} loading={busy === "build"}
                disabled={!config.builder.available || !!running} onClick={() => void submit(true)}>
                {running ? "正在编译" : `生成 ${platformName(platform)} 程序`}
              </Button>
            </div>
          </footer>
        </Form>
      </section>
      <section className="cc-history-panel" aria-labelledby="cc-history-title">
        <div className="cc-history-heading"><div><h2 id="cc-history-title">程序与版本</h2><span className="cc-count">{jobs.length}</span></div>
          <span className="cc-history-refresh"><span className={pollError ? "" : "is-live"} />{pollError ? "同步中断" : "实时同步"}</span>
        </div>
        <div className="cc-history-toolbar"><Segmented value={historyFilter} aria-label="筛选编译记录" onChange={(value) => { setHistoryFilter(value as "all" | Platform); setHistoryPage(1); }}
          options={[{ value: "all", label: "全部" }, { value: "windows", label: "Windows", icon: <PlatformIcon platform="windows" size={13} /> }, { value: "linux", label: "Linux", icon: <PlatformIcon platform="linux" size={14} /> }]} />
          <span>最近 30 条 · 相同程序自动合并</span></div>
        {filteredJobs.length ? <>
          <div className="cc-history-desktop"><Table<BuildJob> rowKey="id" columns={columns} dataSource={filteredJobs} size="middle"
            pagination={{ current: historyPage, pageSize, onChange: setHistoryPage, hideOnSinglePage: true, showSizeChanger: false }}
            rowClassName={(job) => job.id === selectedId ? "cc-record-selected" : ""} tableLayout="fixed" /></div>
          <div className="cc-history-mobile">
            {filteredJobs.slice((historyPage - 1) * pageSize, historyPage * pageSize).map((job) => <article key={job.id} className="cc-mobile-record">
              <div><div className="cc-record-file"><span className={`cc-os-icon cc-os-${job.platform}`}><PlatformIcon platform={job.platform} size={17} /></span>
                <strong>{platformName(job.platform)} <small>v{job.version} · {archName(job.arch)}</small></strong></div><JobStatus status={job.status} published={job.published} /></div>
              <p title={job.server}>{job.server}</p>
              <div><span className="cc-record-date">{relativeTime(job.created_at)} · 程序大小：{job.size == null ? "—" : bytes(job.size)}</span>{historyActions(job)}</div>
            </article>)}
            {filteredJobs.length > pageSize && <Pagination current={historyPage} pageSize={pageSize} total={filteredJobs.length} onChange={setHistoryPage} simple />}
          </div>
        </> : <div className="cc-history-empty"><span><History size={21} strokeWidth={1.5} /></span><div><strong>{historyFilter === "all" ? "还没有编译记录" : `暂无 ${platformName(historyFilter)} 编译记录`}</strong><p>暂无可下载的程序</p></div></div>}
      </section>
      <p className="cc-page-note"><ShieldCheck size={13} />生成的程序包含设备密钥，请仅分发给可信设备。修改连接配置后需重新编译。</p>
    </>}
    <Drawer open={detailOpen} onClose={() => setDetailOpen(false)} title="编译详情" size={680} className="cc-detail-drawer"
      afterOpenChange={(open) => { if (open && logRef.current && followLog.current) logRef.current.scrollTop = logRef.current.scrollHeight; }}>
      {selected ? <>
        <div className="cc-drawer-file"><div className="cc-record-file"><span className={`cc-os-icon cc-os-${selected.platform}`}><PlatformIcon platform={selected.platform} /></span>
          <div><strong>{platformName(selected.platform)} {archName(selected.arch)}</strong><span>v{selected.version} · {selected.filename}</span></div></div><JobStatus status={selected.status} published={selected.published} /></div>
        <p className="cc-drawer-detail">{selected.detail}</p><BuildStages job={selected} />
        <Descriptions size="small" column={1} items={[
          { key: "server", label: "连接地址", children: selected.server },
          { key: "created", label: "创建时间", children: date(selected.created_at) },
          { key: "insecure", label: "连接方式", children: selected.allow_insecure ? "允许内网 ws://" : "仅使用 wss://" },
          ...(selected.size ? [{ key: "size", label: "文件大小", children: bytes(selected.size) }] : []),
          ...(selected.sha256 ? [{ key: "sha256", label: "SHA-256", children: <Typography.Text className="mono cc-checksum" copyable>{selected.sha256}</Typography.Text> }] : []),
        ]} />
        <div className="cc-log-heading"><TerminalSquare size={15} /><h3>编译日志</h3><span>最近 64 KiB</span></div>
        <pre ref={logRef} className="cc-log" tabIndex={0} aria-label="编译日志"
          onScroll={(event) => { const el = event.currentTarget; followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {selected.log || "等待编译日志…"}
        </pre>
        {selected.status === "success" && <Button type="primary" icon={<Download size={15} />} className="cc-drawer-download"
          disabled={!!downloading} loading={downloading === selected.id} onClick={() => void download(selected)}>下载被控端</Button>}
        <div className="cc-drawer-delete">{deleteAction(selected)}</div>
      </> : <Loading />}
    </Drawer>
    <Drawer open={guideOpen} onClose={() => setGuideOpen(false)} title="使用说明" size={480} className="cc-guide-drawer">
      <section><span className="cc-guide-icon"><Link2 size={19} /></span><h3>连接到你的主控</h3><p>填写被控设备可访问的主控地址，例如 <code>wss://remote.example.com</code>。系统会自动拼接固定路径 <code>/agent/ws</code>，无需填写路径或控制台安全入口。设备密钥会自动内置。</p></section>
      <section><span className="cc-guide-icon"><PlatformIcon platform="windows" size={19} /></span><h3>在 Windows 上运行</h3><p>下载 .exe 后直接运行。支持 Windows 10 / Server 2016 及以上版本，需要 Visual C++ 2015–2022 运行库（x64）。</p></section>
      <section><span className="cc-guide-icon"><PlatformIcon platform="linux" size={19} /></span><h3>在 Linux 上运行</h3><p>适用于 glibc 2.36+ 的 x86_64 或 aarch64 系统，需安装对应架构的 libxcb1、libxrandr2、libdbus-1-3、libxkbcommon0，端口查询需要 iproute2。</p><pre>chmod +x rust-remote-client{"\n"}./rust-remote-client</pre><p>程序默认后台运行，不创建日志文件，也不会在终端输出运行日志。使用 kill PID 停止；添加 --foreground 仅保持进程在前台运行。</p></section>
      <section><span className="cc-guide-icon"><Clock3 size={19} /></span><h3>关于编译与更新</h3><p>首次编译需要下载工具链，耗时较长。每次运行一个编译任务，关闭页面后仍会继续，最长一小时。主控重启会中断编译，可从日志查看原因后重试。</p><p>历史产物保留编译时的连接信息。编译成功后自动发布为对应系统的最新版本，可到设备列表发起升级。编译失败保留此前发布的版本，设备升级仍需手动发起。</p></section>
    </Drawer>
  </div>;
}
