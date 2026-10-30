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
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
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
      title: t("deviceName"),
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
              copyable={{ text: d.id, tooltips: [t("copyDeviceId"), t("copied")] }}
            >
              {d.id}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: t("status"),
      key: "online",
      width: 100,
      render: (_, d) => <DeviceStatus online={d.online} />,
    },
    {
      title: t("operatingSystem"),
      dataIndex: "platform",
      className: "device-detail-column",
      width: 260,
      render: (_, d) => <OperatingSystem device={d} />,
    },
    {
      title: t("address"),
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
      title: t("clientVersion"),
      dataIndex: "version",
      className: "device-version-column",
      width: 170,
      render: (value: string, d) => {
        const state = upgradeState(d);
        const version = value ? (/^v/i.test(value) ? value : `v${value}`) : "—";
        const needsUpgrade = state.available || state.manualUpdate;
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
      title: t("lastCommunication"),
      dataIndex: "last_seen",
      className: "device-detail-column",
      width: 190,
      sorter: (a, b) => a.last_seen - b.last_seen,
      render: (value) => (
        <span>{dateTime(value)}</span>
      ),
    },
    {
      title: t("actions"),
      width: 220,
      fixed: screens.md ? "right" : undefined,
      render: (_, d) => (
        <div className="device-row-actions">
          <Button type="link" onClick={() => open(d)}>
            {d.online ? t("manageDevice") : t("viewDetails")}
          </Button>
          <DeviceUpgrade device={d} compact />
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("deviceManagement")}
        description={t("deviceManagementHint")}
        extra={
          <Button
            icon={<RefreshCw size={15} />}
            loading={refreshing}
            onClick={refresh}
          >
            {t("refresh")}
          </Button>
        }
      />
      <div className="summary-strip">
        {[
          {
            label: t("deviceCount"),
            value: devices.length,
            icon: Monitor,
            className: "",
          },
          {
            label: t("currentOnline"),
            value: online,
            icon: Activity,
            className: "success",
          },
          {
            label: t("currentOffline"),
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
                <small>{t("unitDevice")}</small>
              </strong>
            </div>
          </div>
        ))}
        <div className="summary-note">
          <span className={`sync-dot ${syncFailed ? "failed" : updated ? "connected" : ""}`} />
          <div>
            {syncFailed ? t("syncInterrupted") : t("syncEveryFiveSeconds")}<small>{t("lastSuccessful", { time: updated || "—" })}</small>
          </div>
        </div>
      </div>
      <section className="filter-panel" aria-label={t("deviceFilter")}>
        <label className="filter-field">
          <span>{t("deviceSearch")}</span>
          <Input
            aria-label={t("searchDeviceAria")}
            prefix={<Search size={15} />}
            placeholder={t("searchDevicePlaceholder")}
            allowClear
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="filter-field short device-filter-system">
          <span>{t("operatingSystem")}</span>
          <Select
            aria-label={t("operatingSystem")}
            value={platform}
            onChange={(value) => {
              setPlatform(value);
              setPage(1);
            }}
            options={[
              { value: "", label: t("allSystems") },
              { value: "windows", label: "Windows" },
              { value: "linux", label: "Linux" },
            ]}
          />
        </label>
        <label className="filter-field short device-filter-version">
          <span>{t("versionFilter")}</span>
          <Select
            aria-label={t("versionFilter")}
            value={versionFilter}
            onChange={(value) => { setVersionFilter(value); setPage(1); }}
            options={[
              { value: "", label: t("allVersions") },
              { value: "available", label: t("onlineUpgrade") },
              { value: "active", label: t("upgradeInProgress") },
              { value: "attention", label: t("upgradeNeedsAttention") },
            ]}
          />
        </label>
        <Button disabled={!hasFilters} onClick={resetFilters}>
          {t("reset")}
        </Button>
      </section>
      <div className="device-list-meta" aria-live="polite">
        <span>{hasFilters ? t("filteredResults", { filtered: filtered.length, total: totalInTab }) : `${status === "online" ? t("onlineDevices") : t("offlineDevices")} ${totalInTab} ${t("unitDevice")}`}</span>
        <span className="table-scroll-hint">{t("scrollForMore")}</span>
        <span className={syncFailed ? "sync-error" : ""}>
          {syncFailed ? t("retryingSync") : t("recentlySynced", { time: updated || "—" })}
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
                    {t("onlineDevices")} <span className="tab-count">{online}</span>
                  </>
                ),
              },
              {
                key: "offline",
                label: (
                  <>
                    {t("offlineDevices")} {" "}
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
                    ? <span>{t("noFilteredDevices")}<Button type="link" onClick={resetFilters}>{t("clearFilters")}</Button></span>
                    : status === "online"
                      ? t("noOnlineDevices")
                      : t("noOfflineDevices")
                }
              />
            ),
          }}
        />
      </section>
    </>
  );
}
