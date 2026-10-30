import { useEffect, useState } from "react";
import {
  Button,
  Grid,
  Input,
  Select,
  Table,
  Tabs,
  theme,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Activity,
  Circle,
  Monitor,
  RefreshCw,
  Search,
} from "lucide-react";
import type { Device } from "./types";
import DeviceUpgrade from "./DeviceUpgrade";
import OperatingSystem from "./OperatingSystem";
import { useDeviceSystems } from "./useDeviceSystems";
import { upgradeState } from "./upgrade";
import { dateTime } from "./format";
import { navigate } from "./navigation";
import { DeviceStatus, EmptyState, PageHeader, pagination } from "./ui";

export default function DeviceList({
  devices: reportedDevices,
  loading,
  refreshing,
  refresh,
  updated,
  syncFailed,
}: {
  devices: Device[];
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  updated: string;
  syncFailed: boolean;
}) {
  const { token } = theme.useToken();
  const devices = useDeviceSystems(reportedDevices);
  const [status, setStatus] = useState("online");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("");
  const [versionFilter, setVersionFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const screens = Grid.useBreakpoint();
  const online = devices.filter((d) => d.online).length;
  const filtered = devices.filter(
    (d) =>
      d.online === (status === "online") &&
      (!platform || d.platform === platform) &&
      (!versionFilter || (versionFilter === "available" ? upgradeState(d).available
        : versionFilter === "active" ? upgradeState(d).active : upgradeState(d).needsAttention)) &&
      `${d.name} ${d.id} ${d.version} ${d.platform} ${d.os || ""} ${d.distribution_id || ""} ${d.public_ip || ""} ${d.source_ip || ""} ${d.local_addresses?.map((a) => a.address).join(" ") || ""}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  const hasFilters = !!(query.trim() || platform || versionFilter);
  const totalInTab = status === "online" ? online : devices.length - online;
  useEffect(() => {
    setPage((value) => Math.min(value, Math.max(1, Math.ceil(filtered.length / pageSize))));
  }, [filtered.length, pageSize]);
  function resetFilters() {
    setQuery("");
    setPlatform("");
    setVersionFilter("");
    setPage(1);
  }
  const open = (device: Device) =>
    navigate(`/devices/${encodeURIComponent(device.id)}/overview`);
  const columns: ColumnsType<Device> = [
    {
      title: "设备名称",
      key: "name",
      className: "device-detail-column",
      width: 260,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_, d) => (
        <div className="device-cell">
          <span className="device-symbol">
            <Monitor size={18} />
          </span>
          <div>
            <Button type="link" className="cell-link" onClick={() => open(d)}>
              {d.name}
            </Button>
            <Typography.Text
              className="secondary-text device-id"
              ellipsis={{ tooltip: d.id }}
              copyable={{ text: d.id, tooltips: ["复制设备 ID", "已复制"] }}
            >
              {d.id}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: "状态",
      key: "online",
      width: 100,
      render: (_, d) => <DeviceStatus online={d.online} />,
    },
    {
      title: "操作系统",
      dataIndex: "platform",
      className: "device-detail-column",
      width: 260,
      render: (_, d) => <OperatingSystem device={d} />,
    },
    {
      title: "内网 / 来源地址",
      width: 175,
      render: (_, d) => (
        <span className="mono">
          {d.local_addresses?.find((a) => !a.address.includes(":"))?.address ||
            d.source_ip ||
            "—"}
        </span>
      ),
    },
    {
      title: "客户端版本",
      dataIndex: "version",
      className: "device-version-column",
      width: 170,
      render: (value: string, d) => {
        const state = upgradeState(d);
        const version = value ? (/^v/i.test(value) ? value : `v${value}`) : "—";
        const needsUpgrade = state.available || state.label === "需手动更新";
        return (
          <span className="device-version-number mono"
            style={needsUpgrade ? { color: token.colorWarningText } : undefined}
            title={`${version} · ${state.label}\n${state.description}`}
            aria-label={`${version}，${state.label}`}>
            {version}
          </span>
        );
      },
    },
    {
      title: "最近通信",
      dataIndex: "last_seen",
      className: "device-detail-column",
      width: 190,
      sorter: (a, b) => a.last_seen - b.last_seen,
      render: (value) => (
        <span>{dateTime(value)}</span>
      ),
    },
    {
      title: "操作",
      width: 220,
      fixed: screens.md ? "right" : undefined,
      render: (_, d) => (
        <div className="device-row-actions">
          <Button type="link" onClick={() => open(d)}>
            {d.online ? "管理设备" : "查看详情"}
          </Button>
          <DeviceUpgrade device={d} compact />
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="设备管理"
        description="集中查看设备状态，进入设备详情进行管理。"
        extra={
          <Button
            icon={<RefreshCw size={15} />}
            loading={refreshing}
            onClick={refresh}
          >
            刷新
          </Button>
        }
      />
      <div className="summary-strip">
        {[
          {
            label: "设备总数",
            value: devices.length,
            icon: Monitor,
            className: "",
          },
          {
            label: "当前在线",
            value: online,
            icon: Activity,
            className: "success",
          },
          {
            label: "当前离线",
            value: devices.length - online,
            icon: Circle,
            className: "muted",
          },
        ].map((item) => (
          <div className="summary-item" key={item.label}>
            <span className={`summary-icon ${item.className}`}>
              <item.icon size={19} />
            </span>
            <div>
              <span className="secondary-text">{item.label}</span>
              <strong>
                {item.value}
                <small>台</small>
              </strong>
            </div>
          </div>
        ))}
        <div className="summary-note">
          <span className={`sync-dot ${syncFailed ? "failed" : updated ? "connected" : ""}`} />
          <div>
            {syncFailed ? "状态同步中断" : "每 5 秒同步状态"}<small>最近成功 {updated || "—"}</small>
          </div>
        </div>
      </div>
      <section className="filter-panel" aria-label="设备筛选">
        <label className="filter-field">
          <span>设备搜索</span>
          <Input
            aria-label="搜索设备"
            prefix={<Search size={15} />}
            placeholder="名称、ID、IP、系统或版本"
            allowClear
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="filter-field short">
          <span>操作系统</span>
          <Select
            aria-label="操作系统筛选"
            value={platform}
            onChange={(value) => {
              setPlatform(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部系统" },
              { value: "windows", label: "Windows" },
              { value: "linux", label: "Linux" },
            ]}
          />
        </label>
        <label className="filter-field short">
          <span>程序版本</span>
          <Select
            aria-label="程序版本筛选"
            value={versionFilter}
            onChange={(value) => { setVersionFilter(value); setPage(1); }}
            options={[
              { value: "", label: "全部版本" },
              { value: "available", label: "可在线升级" },
              { value: "active", label: "升级进行中" },
              { value: "attention", label: "升级需关注" },
            ]}
          />
        </label>
        <Button disabled={!hasFilters} onClick={resetFilters}>
          重置
        </Button>
      </section>
      <div className="device-list-meta" aria-live="polite">
        <span>{hasFilters ? `筛选结果 ${filtered.length} / ${totalInTab} 台` : `${status === "online" ? "在线" : "离线"}设备 ${totalInTab} 台`}</span>
        <span className="table-scroll-hint">左右滑动查看完整信息</span>
        <span className={syncFailed ? "sync-error" : ""}>
          {syncFailed ? "同步中断，正在自动重试" : `最近同步 ${updated || "—"}`}
        </span>
      </div>
      <section className="table-panel">
        <div className="table-toolbar">
          <Tabs
            activeKey={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            items={[
              {
                key: "online",
                label: (
                  <>
                    在线设备 <span className="tab-count">{online}</span>
                  </>
                ),
              },
              {
                key: "offline",
                label: (
                  <>
                    离线设备{" "}
                    <span className="tab-count">{devices.length - online}</span>
                  </>
                ),
              },
            ]}
          />
        </div>
        <Table<Device>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          size="small"
          scroll={{ x: 1375 }}
          pagination={{ ...pagination, current: page, pageSize,
            onChange: (next, size) => { setPage(size === pageSize ? next : 1); setPageSize(size); } }}
          locale={{
            emptyText: (
              <EmptyState
                description={
                  hasFilters
                    ? <span>没有符合筛选条件的设备<Button type="link" onClick={resetFilters}>清除筛选</Button></span>
                    : status === "online"
                      ? "暂无在线设备，客户端连接后会显示在这里"
                      : "暂无离线设备"
                }
              />
            ),
          }}
        />
      </section>
    </>
  );
}
