import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Progress,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  Activity,
  ArrowLeft,
  Cpu,
  Download,
  Folder,
  HardDrive,
  LayoutDashboard,
  Monitor,
  Network,
  RefreshCw,
  Terminal,
  Upload,
  Variable,
} from "lucide-react";
import { command } from "./api";
import { bytes, date, dateOnly } from "./format";
import { navigate } from "./navigation";
import { DeviceStatus, Loading } from "./ui";
import type { Device, Info } from "./types";
import { OperatingSystemIcon } from "./OperatingSystem";
import RuntimeIdentity from "./RuntimeIdentity";
import ConnectionHistory from "./ConnectionHistory";
import DeviceUpgrade from "./DeviceUpgrade";
import FilesView from "./FilesView";
import {
  EnvironmentView,
  PortsView,
  ProcessesView,
  ScreenView,
  ShellView,
} from "./DeviceTools";

const tabs = [
  { key: "overview", label: "设备概览", icon: <LayoutDashboard size={15} /> },
  { key: "files", label: "文件管理", icon: <Folder size={15} /> },
  { key: "screen", label: "屏幕观察", icon: <Monitor size={15} /> },
  { key: "processes", label: "进程列表", icon: <Activity size={15} /> },
  { key: "environment", label: "环境变量", icon: <Variable size={15} /> },
  { key: "ports", label: "端口连接", icon: <Network size={15} /> },
  { key: "shell", label: "终端命令", icon: <Terminal size={15} /> },
  { key: "connections", label: "上下线记录", icon: <Activity size={15} /> },
];
export default function DeviceWorkspace({
  device,
  tab,
}: {
  device: Device;
  tab: string;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(device.online);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");
  const generation = useRef(0);
  // Older clients used screen-input-v1 for desktop support without declaring screen-v1.
  const screenAvailable = device.capabilities?.includes("screen-v1")
    || device.capabilities?.includes("screen-input-v1")
    || false;
  const activeTab = tabs.some((t) => t.key === tab) && (tab !== "screen" || screenAvailable) ? tab : "overview";
  const tabItems = tabs.map((item) => item.key === "screen" ? { ...item, disabled: !screenAvailable } : item);
  const refresh = useCallback(async () => {
    if (!device.online) { setBusy(false); return; }
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await command<Info>(device.id, "system.info");
      if (generation.current === current) {
        setInfo(result);
        setFetchedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      }
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [device.id, device.online, device.version]);
  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => {
    setError("");
  }, [activeTab]);
  const addresses = info?.local_addresses ?? device.local_addresses ?? [];
  const publicIp = info?.public_ip || device.public_ip;
  return (
    <>
      <section className="device-heading">
        <div className="device-heading-top">
          <Button
            type="text"
            icon={<ArrowLeft size={17} />}
            aria-label="返回设备列表"
            onClick={() => navigate("/devices")}
          />
          <span className="device-heading-icon">
            <Monitor size={23} />
          </span>
          <div className="device-title">
            <div>
              <h1>{device.name}</h1>
              <div className="device-status-actions">
                <DeviceStatus online={device.online} />
                <DeviceUpgrade device={device} key={device.id} />
              </div>
            </div>
            <Typography.Text className="secondary-text mono" copyable>
              {device.id}
            </Typography.Text>
          </div>
          <Tag className="device-platform">
            {device.platform === "windows" ? "Windows" : "Linux"} ·{" "}
            {device.arch}
          </Tag>
        </div>
        <Tabs
          className="workspace-tabs"
          activeKey={activeTab}
          items={tabItems}
          onChange={(key) =>
            navigate(`/devices/${encodeURIComponent(device.id)}/${key}`)
          }
        />
      </section>
      {error && (
        <Alert
          className="page-alert"
          type="error"
          showIcon
          title="操作未完成"
          description={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {!device.online && (
        <Alert
          className="page-alert"
          type="warning"
          showIcon
          title="设备已离线"
          description="远程操作暂不可用。仍可查看连接记录和最近保存的网络信息。"
        />
      )}
      {activeTab === "connections" ? (
        <ConnectionHistory id={device.id} />
      ) : activeTab === "overview" ? (
        <>
          <div className="section-toolbar">
            <span className="secondary-text">
              {fetchedAt
                ? `系统信息获取于 ${fetchedAt}${!device.online ? "（离线前）" : ""}`
                : "设备概览"}
            </span>
            <Button
              icon={<RefreshCw size={14} />}
              loading={busy}
              disabled={!device.online}
              onClick={() => void refresh()}
            >
              刷新信息
            </Button>
          </div>
          <div className="overview-grid">
            <Card
              title="系统信息"
              className="detail-card"
              extra={<Tag>{device.version}</Tag>}
            >
              {busy && !info ? (
                <Loading />
              ) : info ? (
                <>
                  <Descriptions
                    size="small"
                    column={1}
                    items={[
                      {
                        key: "hostname",
                        label: "主机名称",
                        children: info.hostname,
                      },
                      {
                        key: "os",
                        label: "操作系统",
                        children: (
                          <span className="system-value">
                            <OperatingSystemIcon
                              device={{
                                ...device,
                                os: info.os,
                                distribution_id: info.distribution_id ?? device.distribution_id,
                                kernel_version: info.kernel_version ?? device.kernel_version,
                                arch: info.arch || device.arch,
                              }}
                              size={16}
                            />
                            {info.os}
                          </span>
                        ),
                      },
                      {
                        key: "uptime",
                        label: "系统运行时间",
                        children: `${Math.floor(info.uptime / 3600)} 小时 ${Math.floor((info.uptime % 3600) / 60)} 分钟`,
                      },
                    ]}
                  />
                  <div className="resource-meters">
                    <div className="resource-meter cpu-meter">
                      <div>
                        <span className="resource-label"><Cpu size={15} />CPU 使用率</span>
                        <span className="resource-tags">
                          <Tag>{info.cpu_count} 核</Tag>
                          <Tag>{info.arch}</Tag>
                          <strong>{Math.round(info.cpu_usage ?? 0)}%</strong>
                        </span>
                      </div>
                      <Progress
                        percent={Math.min(100, Math.max(0, Math.round(info.cpu_usage ?? 0)))}
                        size="small"
                      />
                    </div>
                    <div className="resource-meter">
                      <div>
                        <span className="resource-label"><Activity size={15} />内存使用</span>
                        <span>{bytes(info.memory_used)} / {bytes(info.memory_total)}</span>
                      </div>
                      <Progress
                        percent={info.memory_total ? Math.round((info.memory_used / info.memory_total) * 100) : 0}
                        size="small"
                      />
                    </div>
                  </div>
                  <div className="io-grid">
                    <div className="io-item">
                      <span className="io-icon network"><Download size={15} /></span>
                      <span><small>网络下行累计</small><strong>{bytes(info.network_received ?? 0)}</strong></span>
                    </div>
                    <div className="io-item">
                      <span className="io-icon network"><Upload size={15} /></span>
                      <span><small>网络上行累计</small><strong>{bytes(info.network_transmitted ?? 0)}</strong></span>
                    </div>
                    <div className="io-item">
                      <span className="io-icon disk"><HardDrive size={15} /></span>
                      <span><small>磁盘读取累计</small><strong>{bytes(info.disk_read ?? 0)}</strong></span>
                    </div>
                    <div className="io-item">
                      <span className="io-icon disk"><HardDrive size={15} /></span>
                      <span><small>磁盘写入累计</small><strong>{bytes(info.disk_written ?? 0)}</strong></span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="detail-placeholder">
                  {device.online
                    ? "系统信息暂不可用，请重试。"
                    : "设备重新连接后可获取系统信息。"}
                </div>
              )}
            </Card>
            <Card
              title="网络地址"
              className="detail-card"
              extra={
                <span className="secondary-text">
                  {device.online ? "最近上报" : "历史信息"}
                </span>
              }
            >
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    key: "lan",
                    label: "本机网卡地址",
                    children: addresses.length ? (
                      <div className="address-list">
                        {addresses.map((a) => (
                          <div key={`${a.interface}:${a.address}`}>
                            <span className="mono">{a.address}</span>
                            <span className="secondary-text">
                              {a.interface}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      "尚未上报"
                    ),
                  },
                  {
                    key: "public",
                    label: "公网地址",
                    children: (
                      <div className="network-address-value">
                        <span className="mono">{publicIp || "未获取"}</span>
                        {publicIp && (
                          <div className="secondary-text">
                            {info?.public_ip ||
                            device.public_ip_source === "ipinfo.io"
                              ? "ipinfo.io · 设备出口"
                              : "设备连接来源"}
                          </div>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "source",
                    label: "连接来源地址",
                    children: (
                      <span className="mono">{device.source_ip || "—"}</span>
                    ),
                  },
                  {
                    key: "reported",
                    label: "地址更新时间",
                    children: device.reported_at
                      ? date(device.reported_at)
                      : "尚未上报",
                  },
                  {
                    key: "seen",
                    label: "最近通信",
                    children: <Typography.Text>
                      {dateOnly(device.last_seen)}
                    </Typography.Text>,
                  },
                ]}
              />
            </Card>
          </div>
          {info && (
            <RuntimeIdentity
              info={info.runtime_identity}
              platform={device.platform}
            />
          )}
        </>
      ) : device.online ? (
        <div className="tool-workspace" key={activeTab}>
          {activeTab === "files" ? (
            !info && busy ? (
              <Card>
                <Loading />
              </Card>
            ) : (
              <FilesView
                id={device.id}
                initialPath={info?.default_path || "."}
              />
            )
          ) : activeTab === "screen" ? (
            <ScreenView id={device.id} setError={setError} inputSupported={device.capabilities?.includes("screen-input-v1") ?? false} />
          ) : activeTab === "processes" ? (
            <ProcessesView id={device.id} setError={setError} killSupported={device.capabilities?.includes("process-kill-v1") ?? false} />
          ) : activeTab === "environment" ? (
            <EnvironmentView id={device.id} setError={setError} />
          ) : activeTab === "ports" ? (
            <PortsView id={device.id} setError={setError} />
          ) : (
            <ShellView
              id={device.id}
              disabled={!info || !info.shell_enabled}
              interactive={device.platform !== "windows" && (device.capabilities?.includes("terminal-v1") ?? false)}
              setError={setError}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
