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
import { useTranslation } from "react-i18next";

export default function DeviceWorkspace({
  device,
  tab,
}: {
  device: Device;
  tab: string;
}) {
  const { t } = useTranslation();
  const tabs = [
    { key: "overview", label: t("deviceOverview"), icon: <LayoutDashboard size={15} /> },
    { key: "files", label: t("fileManagement"), icon: <Folder size={15} /> },
    { key: "screen", label: t("screenWatching"), icon: <Monitor size={15} /> },
    { key: "processes", label: t("processList"), icon: <Activity size={15} /> },
    { key: "environment", label: t("environmentVariables"), icon: <Variable size={15} /> },
    { key: "ports", label: t("portConnections"), icon: <Network size={15} /> },
    { key: "shell", label: t("terminalCommands"), icon: <Terminal size={15} /> },
    { key: "connections", label: t("connectionHistory"), icon: <Activity size={15} /> },
  ];
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
            aria-label={t("backToDeviceList")}
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
          title={t("operationIncomplete")}
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
          title={t("deviceOffline")}
          description={t("offlineHint")}
        />
      )}
      {activeTab === "connections" ? (
        <ConnectionHistory id={device.id} />
      ) : activeTab === "overview" ? (
        <>
          <div className="section-toolbar">
            <span className="secondary-text">
              {fetchedAt
                ? t("infoFetchedAt", { time: fetchedAt, offline: !device.online ? t("offlineBefore") : "" })
                : t("deviceOverview")}
            </span>
            <Button
              icon={<RefreshCw size={14} />}
              loading={busy}
              disabled={!device.online}
              onClick={() => void refresh()}
            >
              {t("refreshInfo")}
            </Button>
          </div>
          <div className="overview-grid">
            <Card
              title={t("systemInfo")}
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
                        label: t("hostname"),
                        children: info.hostname,
                      },
                      {
                        key: "os",
                        label: t("os"),
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
                        label: t("uptime"),
                        children: `${Math.floor(info.uptime / 3600)} h ${Math.floor((info.uptime % 3600) / 60)} min`,
                      },
                    ]}
                  />
                  <div className="resource-meters">
                    <div className="resource-meter cpu-meter">
                      <div>
                        <span className="resource-label"><Cpu size={15} />{t("cpuUsage")}</span>
                        <span className="resource-tags">
                          <Tag>{info.cpu_count} {t("cores")}</Tag>
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
                        <span className="resource-label"><Activity size={15} />{t("memoryUsage")}</span>
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
                      <span><small>{t("networkDownload")}</small><strong>{bytes(info.network_received ?? 0)}</strong></span>
                    </div>
                    <div className="io-item">
                      <span className="io-icon network"><Upload size={15} /></span>
                      <span><small>{t("networkUpload")}</small><strong>{bytes(info.network_transmitted ?? 0)}</strong></span>
                    </div>
                    <div className="io-item">
                      <span className="io-icon disk"><HardDrive size={15} /></span>
                      <span><small>{t("diskRead")}</small><strong>{bytes(info.disk_read ?? 0)}</strong></span>
                    </div>
                    <div className="io-item">
                      <span className="io-icon disk"><HardDrive size={15} /></span>
                      <span><small>{t("diskWrite")}</small><strong>{bytes(info.disk_written ?? 0)}</strong></span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="detail-placeholder">
                  {device.online
                    ? t("infoUnavailable")
                    : t("reconnectForInfo")}
                </div>
              )}
            </Card>
            <Card
              title={t("networkAddresses")}
              className="detail-card"
              extra={
                <span className="secondary-text">
                  {device.online ? t("recentlyReported") : t("historicalInfo")}
                </span>
              }
            >
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    key: "lan",
                    label: t("localAddress"),
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
                      t("notReported")
                    ),
                  },
                  {
                    key: "public",
                    label: t("publicAddress"),
                    children: (
                      <div className="network-address-value">
                        <span className="mono">{publicIp || t("notFetched")}</span>
                        {publicIp && (
                          <div className="secondary-text">
                            {info?.public_ip ||
                            device.public_ip_source === "ipinfo.io"
                              ? "ipinfo.io · " + t("publicAddress")
                              : t("connectionSourceAddress")}
                          </div>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "source",
                    label: t("connectionSource"),
                    children: (
                      <span className="mono">{device.source_ip || "—"}</span>
                    ),
                  },
                  {
                    key: "reported",
                    label: t("addressUpdated"),
                    children: device.reported_at
                      ? date(device.reported_at)
                      : t("notReported"),
                  },
                  {
                    key: "seen",
                    label: t("recentCommunication"),
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
