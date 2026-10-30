import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { api } from "./api";
import { date } from "./format";
import { EmptyState } from "./ui";
import { usePageLoading } from "./PageTransition";
import { useTranslation } from "react-i18next";

type Record = {
  id: number;
  device_id: string;
  device_name: string;
  device_platform: string;
  connected_at: number;
  disconnected_at: number | null;
  reason: string | null;
};
const reasonKeys: { [key: string]: string } = {
  disconnected: "connectionLost", reconnected: "replacedByNewConnection", heartbeat_timeout: "heartbeatTimeout",
  invalid_message: "protocolError", controller_shutdown: "controllerStopped", controller_restart: "controllerRestarted",
};
export default function ConnectionHistory({
  id,
  onDevice,
}: {
  id?: string;
  onDevice?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1];
  const [data, setData] = useState<{
    items: Record[];
    next_before: number | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  usePageLoading(busy);
  const [query, setQuery] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(
    async (visible = true) => {
      const current = ++generation.current;
      if (visible) setBusy(true);
      try {
        const result = await api<{
          items: Record[];
          next_before: number | null;
        }>(
          `${id ? `/devices/${encodeURIComponent(id)}` : ""}/connections${before ? `?before=${before}` : ""}`,
        );
        if (current === generation.current) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (current === generation.current) setError((e as Error).message);
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [id, before],
  );
  useEffect(() => {
    void refresh();
    const timer =
      before === null
        ? setInterval(() => void refresh(false), 5000)
        : undefined;
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh, before]);
  const columns: ColumnsType<Record> = [
    ...(!id
      ? [
          {
            title: t("device"),
            width: 240,
            render: (_: unknown, row: Record) => (
              <div>
                <Button
                  type="link"
                  className="cell-link"
                  onClick={() => onDevice?.(row.device_id)}
                >
                  {row.device_name}
                </Button>
                <Typography.Text
                  className="secondary-text device-id"
                  ellipsis={{ tooltip: row.device_id }}
                >
                  {row.device_id}
                </Typography.Text>
              </div>
            ),
          },
        ]
      : []),
    { title: t("connectedAt"), dataIndex: "connected_at", width: 190, render: date },
    {
      title: t("disconnectedAt"),
      dataIndex: "disconnected_at",
      width: 190,
      render: (value) => (value === null ? "—" : date(value)),
    },
    {
      title: t("duration"),
      width: 165,
      render: (_, row) => {
        const s = Math.max(
          0,
          Math.floor(
            (row.disconnected_at ?? Date.now() / 1000) - row.connected_at,
          ),
        );
        return `${Math.floor(s / 3600)} ${t("hours")} ${Math.floor((s % 3600) / 60)} ${t("minutes")} ${s % 60} ${t("seconds")}`;
      },
    },
    {
      title: t("connectionStatus"),
      width: 110,
      render: (_, row) => (
        <Tag color={row.disconnected_at === null ? "success" : "default"}>
          {row.disconnected_at === null ? t("connecting") : t("disconnected")}
        </Tag>
      ),
    },
    {
      title: t("disconnectReason"),
      width: 220,
      render: (_, row) =>
        row.disconnected_at === null
          ? "—"
          : t(reasonKeys[row.reason || ""] || "connectionLost"),
    },
  ];
  return (
    <section className="table-panel">
      <div className="table-toolbar">
        <div className="toolbar-title">
          {t("connectionRecords")}
          <span className="secondary-text">
            {before === null ? t("liveUpdating") : t("history")}
          </span>
        </div>
        <div className="toolbar-actions">
          {!id && (
            <Input
              aria-label={t("searchConnections")}
              prefix={<Search size={14} />}
              placeholder={t("searchDevice")}
              allowClear
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <Button
            icon={<RefreshCw size={14} />}
            loading={busy}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </Button>
        </div>
      </div>
      {error && (
        <Alert className="inline-alert" type="error" showIcon title={error} />
      )}
      <Table<Record>
        rowKey="id"
        columns={columns}
        dataSource={(data?.items ?? []).filter((row) =>
          `${row.device_name} ${row.device_id}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )}
        loading={busy}
        pagination={false}
        size="small"
        scroll={{ x: id ? 875 : 1115 }}
        locale={{
          emptyText: (
            <EmptyState
              description={
                error
                  ? t("loadRecordsFailed")
                  : query
                    ? t("noMatchingDevice")
                    : t("noConnections")
              }
            />
          ),
        }}
      />
      <div className="table-footer">
        <span className="secondary-text">
          {t("pageInfo", { page: cursors.length })}
          {query ? t("searchCurrentPage") : ""}
        </span>
        <div className="toolbar-actions">
          <Button
            disabled={before === null || busy}
            onClick={() => setCursors([null])}
          >
            {t("latestRecords")}
          </Button>
          <Button
            aria-label={t("previousConnections")}
            icon={<ChevronLeft size={14} />}
            disabled={cursors.length === 1 || busy}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          />
          <Button
            aria-label={t("nextConnections")}
            icon={<ChevronRight size={14} />}
            disabled={!data?.next_before || busy}
            onClick={() => setCursors((c) => [...c, data!.next_before])}
          />
        </div>
      </div>
    </section>
  );
}
