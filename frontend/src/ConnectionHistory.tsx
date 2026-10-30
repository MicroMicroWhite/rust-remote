import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { api } from "./api";
import { date } from "./format";
import { EmptyState } from "./ui";
import { usePageLoading } from "./PageTransition";

type Record = {
  id: number;
  device_id: string;
  device_name: string;
  device_platform: string;
  connected_at: number;
  disconnected_at: number | null;
  reason: string | null;
};
const reasons: { [key: string]: string } = {
  disconnected: "连接断开",
  reconnected: "新连接替换",
  heartbeat_timeout: "心跳超时",
  invalid_message: "协议错误",
  controller_shutdown: "主控停止",
  controller_restart: "主控重启（按最后通信时间）",
};
export default function ConnectionHistory({
  id,
  onDevice,
}: {
  id?: string;
  onDevice?: (id: string) => void;
}) {
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
            title: "设备",
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
    { title: "上线时间", dataIndex: "connected_at", width: 190, render: date },
    {
      title: "下线时间",
      dataIndex: "disconnected_at",
      width: 190,
      render: (value) => (value === null ? "—" : date(value)),
    },
    {
      title: "连接时长",
      width: 165,
      render: (_, row) => {
        const s = Math.max(
          0,
          Math.floor(
            (row.disconnected_at ?? Date.now() / 1000) - row.connected_at,
          ),
        );
        return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分 ${s % 60} 秒`;
      },
    },
    {
      title: "连接状态",
      width: 110,
      render: (_, row) => (
        <Tag color={row.disconnected_at === null ? "success" : "default"}>
          {row.disconnected_at === null ? "连接中" : "已断开"}
        </Tag>
      ),
    },
    {
      title: "断开原因",
      width: 220,
      render: (_, row) =>
        row.disconnected_at === null
          ? "—"
          : reasons[row.reason || ""] || "连接断开",
    },
  ];
  return (
    <section className="table-panel">
      <div className="table-toolbar">
        <div className="toolbar-title">
          连接记录
          <span className="secondary-text">
            {before === null ? "每 5 秒更新" : "历史记录"}
          </span>
        </div>
        <div className="toolbar-actions">
          {!id && (
            <Input
              aria-label="搜索本页连接记录"
              prefix={<Search size={14} />}
              placeholder="搜索本页设备"
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
            刷新
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
                  ? "记录加载失败，请重试"
                  : query
                    ? "本页没有匹配的设备"
                    : "暂无连接记录"
              }
            />
          ),
        }}
      />
      <div className="table-footer">
        <span className="secondary-text">
          第 {cursors.length} 页 · 每页最多 50 条
          {query ? " · 搜索范围为当前页" : ""}
        </span>
        <div className="toolbar-actions">
          <Button
            disabled={before === null || busy}
            onClick={() => setCursors([null])}
          >
            最新记录
          </Button>
          <Button
            aria-label="上一页连接记录"
            icon={<ChevronLeft size={14} />}
            disabled={cursors.length === 1 || busy}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          />
          <Button
            aria-label="下一页连接记录"
            icon={<ChevronRight size={14} />}
            disabled={!data?.next_before || busy}
            onClick={() => setCursors((c) => [...c, data!.next_before])}
          />
        </div>
      </div>
    </section>
  );
}
