import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { Check, Clock3, RefreshCw, Search, Info, X } from "lucide-react";
import { api } from "./api";
import { displayPath } from "./path";
import { PageHeader } from "./ui";
import { usePageLoading } from "./PageTransition";

type AuditRecord = {
  id: number;
  time: number;
  trace_id: string;
  device_id: string | null;
  device_name: string | null;
  action: string;
  action_label: string;
  status: string;
  detail: string;
  target: string;
  source_ip: string | null;
  duration_ms: number | null;
};
type AuditPage = {
  items: AuditRecord[];
  summary: { total: number; success: number; errors: number; pending: number };
};
const statuses: Record<string, { label: string; color: string }> = {
  success: { label: "成功", color: "success" },
  failed: { label: "失败", color: "error" },
  timeout: { label: "超时", color: "warning" },
  denied: { label: "已拒绝", color: "error" },
  started: { label: "进行中", color: "processing" },
  interrupted: { label: "结果未知", color: "warning" },
};
const date = (value: number) =>
  new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
const duration = (value: number | null) =>
  value === null
    ? "未记录"
    : value < 1000
      ? `${value} ms`
      : `${(value / 1000).toFixed(2)} s`;

function ResultTag({ status }: { status: string }) {
  const item = statuses[status] ?? { label: status, color: "default" };
  return (
    <Tag
      color={item.color}
      icon={
        status === "success" ? (
          <Check size={12} />
        ) : status === "started" ? (
          <Clock3 size={12} />
        ) : (
          <X size={12} />
        )
      }
    >
      {item.label}
    </Tag>
  );
}

export default function AuditView() {
  const [data, setData] = useState<AuditPage>({
    items: [],
    summary: { total: 0, success: 0, errors: 0, pending: 0 },
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [busy, setBusy] = useState(true);
  usePageLoading(busy);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AuditRecord | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(
    async (visible = true) => {
      const current = ++generation.current;
      if (visible) setBusy(true);
      try {
        const query = new URLSearchParams({
          page: String(page),
          page_size: String(pageSize),
          category,
          status,
          search,
        });
        const result = await api<AuditPage>(`/audit/records?${query}`);
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
    [page, pageSize, category, status, search],
  );
  useEffect(() => {
    void refresh();
    const timer =
      page === 1 ? setInterval(() => void refresh(false), 10000) : undefined;
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh, page]);
  const detail = data.items.find((row) => row.id === selected?.id) ?? selected;
  const columns: ColumnsType<AuditRecord> = [
    { title: "操作时间", dataIndex: "time", width: 180, render: date },
    {
      title: "操作类型",
      dataIndex: "action_label",
      width: 160,
      render: (value) => <span className="audit-operation">{value}</span>,
    },
    {
      title: "设备",
      width: 180,
      render: (_, row) => (
        <div>
          {row.device_name || (row.device_id ? "历史设备" : "管理控制台")}
          <div className="muted audit-device-id">
            {row.device_id || "管理员会话"}
          </div>
        </div>
      ),
    },
    {
      title: "结果",
      dataIndex: "status",
      width: 110,
      render: (value) => <ResultTag status={value} />,
    },
    {
      title: "操作对象 / 说明",
      width: 320,
      render: (_, row) => (
        <div>
          <div className="audit-target" title={row.target}>
            {row.target ? displayPath(row.target) : "历史记录未保存操作对象"}
          </div>
          <div className="muted audit-summary-text">{row.detail}</div>
        </div>
      ),
    },
    { title: "耗时", dataIndex: "duration_ms", width: 100, render: duration },
    {
      title: "操作",
      width: 80,
      fixed: "right",
      render: (_, row) => (
        <Button type="link" onClick={() => setSelected(row)}>
          详情
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="操作审计"
        description="追踪管理操作的执行结果，查看操作对象与失败原因。"
        extra={
          <Button
            icon={<RefreshCw size={15} />}
            loading={busy}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        }
      />
      <div className="summary-strip audit-summary">
        {(
          [
            ["筛选结果", data.summary.total],
            ["执行成功", data.summary.success],
            ["异常 / 未确认", data.summary.errors],
            ["正在执行", data.summary.pending],
          ] as const
        ).map(([label, value]) => (
          <div className="summary-item" key={label}>
            <div>
              <span className="secondary-text">{label}</span>
              <strong>
                {value}
                <small>条</small>
              </strong>
            </div>
          </div>
        ))}
      </div>
      <section className="filter-panel" aria-label="审计筛选">
        <label className="filter-field">
          <span>关键词</span>
          <Input.Search
            aria-label="搜索审计记录"
            prefix={<Search size={15} />}
            placeholder="设备、路径或请求编号"
            maxLength={128}
            allowClear
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              if (!event.target.value) {
                setSearch("");
                setPage(1);
              }
            }}
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
        </label>
        <label className="filter-field short">
          <span>操作类型</span>
          <Select
            aria-label="操作类型"
            value={category}
            onChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部类型" },
              { value: "auth", label: "登录与会话" },
              { value: "files", label: "文件操作" },
              { value: "shell", label: "终端命令" },
              { value: "system", label: "设备信息查询" },
            ]}
          />
        </label>
        <label className="filter-field short">
          <span>操作结果</span>
          <Select
            aria-label="操作结果"
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部结果" },
              ...Object.entries(statuses).map(([value, item]) => ({
                value,
                label: item.label,
              })),
            ]}
          />
        </label>
        <Button
          onClick={() => {
            setCategory("");
            setStatus("");
            setSearch("");
            setSearchInput("");
            setPage(1);
          }}
        >
          重置
        </Button>
      </section>
      {error && (
        <Alert
          className="page-alert"
          type="error"
          showIcon
          title="记录加载失败"
          description={error}
          action={
            <Button size="small" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      )}
      <section className="table-panel audit-panel">
        <div className="table-toolbar">
          <div className="toolbar-title">
            操作记录<span className="secondary-text">一次操作对应一条记录</span>
          </div>
          <span className="secondary-text">
            {page === 1 ? "每 10 秒更新" : "历史记录"}
          </span>
        </div>
        <Table<AuditRecord>
          rowKey="id"
          columns={columns}
          dataSource={data.items}
          loading={busy}
          size="small"
          scroll={{ x: 1130 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="没有匹配的操作记录"
              />
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total: data.summary.total,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (total) => `共 ${total} 条记录`,
            onChange: (next, size) => {
              setPage(size !== pageSize ? 1 : next);
              setPageSize(size);
            },
          }}
        />
        <div className="panel-note">
          <Info size={14} />
          <span>
            设备连接历史请查看“上下线记录”。审计不保存密码、命令正文或文件内容。
          </span>
        </div>
      </section>
      <Drawer
        title="操作详情"
        open={!!detail}
        onClose={() => setSelected(null)}
        size={480}
      >
        {detail && (
          <>
            <div className="audit-drawer-title">
              <h2>{detail.action_label}</h2>
              <ResultTag status={detail.status} />
            </div>
            <Alert
              type={
                detail.status === "success"
                  ? "success"
                  : detail.status === "started"
                    ? "info"
                    : "warning"
              }
              showIcon
              title={detail.detail}
            />
            <Descriptions
              column={1}
              bordered
              size="small"
              className="audit-description"
              items={[
                { key: "time", label: "操作时间", children: date(detail.time) },
                {
                  key: "device",
                  label: "目标设备",
                  children:
                    detail.device_name || detail.device_id || "管理控制台",
                },
                {
                  key: "target",
                  label: "操作对象",
                  children: detail.target
                    ? displayPath(detail.target)
                    : "历史记录未保存",
                },
                {
                  key: "duration",
                  label: "执行耗时",
                  children: duration(detail.duration_ms),
                },
                {
                  key: "actor",
                  label: "操作者",
                  children:
                    detail.status === "denied" && detail.action === "login"
                      ? "未通过验证的访客"
                      : "管理员",
                },
                {
                  key: "source",
                  label: "请求来源地址",
                  children: detail.source_ip || "历史记录未保存",
                },
                {
                  key: "trace",
                  label: "请求编号（排查问题时使用）",
                  children: (
                    <Typography.Text code copyable>
                      {detail.trace_id}
                    </Typography.Text>
                  ),
                },
                {
                  key: "action",
                  label: "操作标识",
                  children: (
                    <Typography.Text code>{detail.action}</Typography.Text>
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
