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
import { useTranslation } from "react-i18next";
import { translateServerText } from "./serverText";

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
const statuses: Record<string, { key: string; color: string }> = {
  success: { key: "success", color: "success" }, failed: { key: "failed", color: "error" }, timeout: { key: "timeout", color: "warning" }, denied: { key: "denied", color: "error" }, started: { key: "started", color: "processing" }, interrupted: { key: "interrupted", color: "warning" },
};
const date = (value: number) =>
  new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
const duration = (value: number | null) =>
  value === null
    ? "—"
    : value < 1000
      ? `${value} ms`
      : `${(value / 1000).toFixed(2)} s`;
const actionKeys: Record<string, string> = { "terminal.session": "auditAction.terminalSession", "device.delete": "auditAction.deviceDelete", "client.delete": "auditAction.clientDelete", "client.build": "auditAction.clientBuild", "client.download": "auditAction.clientDownload", "client.config": "auditAction.clientConfig", "client.publish": "auditAction.clientPublish", "agent.update": "auditAction.agentUpdate", "agent.reinstall": "auditAction.agentReinstall", "fs.list": "auditAction.fsList", "fs.mkdir": "auditAction.fsMkdir", "fs.delete": "auditAction.fsDelete", "fs.rename": "auditAction.fsRename", "fs.text": "auditAction.fsText", "fs.edit": "auditAction.fsEdit", "fs.read": "auditAction.fsRead", "fs.write": "auditAction.fsWrite", "process.kill": "auditAction.processKill", "process.list": "auditAction.processList", "system.info": "auditAction.systemInfo", "system.environment": "auditAction.systemEnvironment", "ports.list": "auditAction.portsList", "shell.exec": "auditAction.shellExec", "screen.capture": "auditAction.screenCapture", "screen.observe": "auditAction.screenObserve", "screen.input": "auditAction.screenInput", login: "auditAction.login", logout: "auditAction.logout" };
function translatedAction(row: AuditRecord, t: (key: string, options?: Record<string, unknown>) => string) { return actionKeys[row.action] ? t(actionKeys[row.action]) : row.action_label; }
function translatedTarget(row: AuditRecord, t: (key: string, options?: Record<string, unknown>) => string) { if (!row.target) return t("historicalTargetMissing"); if (row.action === "process.kill") return t("auditTarget.pid", { pid: row.target.replace(/^PID\s*/, "") }); if (row.action === "shell.exec") return t("auditTarget.shell"); if (row.action === "terminal.session") return t("auditTarget.terminal"); if (row.action === "system.info") return t("auditTarget.systemInfo"); if (row.action === "system.environment") return t("auditTarget.environment"); if (row.action === "process.list") return t("auditTarget.processes"); if (row.action === "ports.list") return t("auditTarget.ports"); return displayPath(row.target); }
function translatedDetail(row: AuditRecord, t: (key: string, options?: Record<string, unknown>) => string) { const count = row.detail.match(/(?:\u5df2\u8bfb\u53d6\s*)?(\d+)\s*\u4e2a\u76ee\u5f55\u9879/)?.[1] || "0"; const keys: Record<string, string> = { "system.info.success": "auditDetail.system_info_success", "system.environment.success": "auditDetail.system_environment_success", "process.list.success": "auditDetail.process_list_success", "fs.text.success": "auditDetail.fs_text_success", "fs.list.success": "auditDetail.fs_list_success", "fs.mkdir.success": "auditDetail.fs_mkdir_success", "fs.delete.success": "auditDetail.fs_delete_success", "fs.rename.success": "auditDetail.fs_rename_success", "fs.edit.success": "auditDetail.fs_edit_success", "fs.read.success": "auditDetail.fs_read_success", "fs.write.success": "auditDetail.fs_write_success", "screen.capture.success": "auditDetail.screen_capture_success", "screen.input.success": "auditDetail.screen_input_success", "process.kill.success": "auditDetail.process_kill_success", "terminal.session.success": "auditDetail.terminal_session_success" }; if (row.action === "client.delete") return t("auditDetail.clientDelete", { count: row.detail.match(/\u5171\s*(\d+)\s*\u6761/)?.[1] || "1" }); if (row.action === "shell.exec" || row.action === "ports.list") return t(`auditDetail.command_${row.status}`, { code: row.detail.match(/\u9000\u51fa\u7801\s*(\d+)/)?.[1] || "0" }); const key = keys[`${row.action}.${row.status}`]; return key ? t(key, { count }) : translateServerText(row.detail, t); }

function ResultTag({ status, t }: { status: string; t: (key: string) => string }) {
  const item = statuses[status] ?? { key: status, color: "default" };
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
      {t(`auditStatus.${item.key}`)}
    </Tag>
  );
}

export default function AuditView() {
  const { t } = useTranslation();
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
    { title: t("operationTime"), dataIndex: "time", width: 180, render: date },
    {
      title: t("operationType"),
      dataIndex: "action_label",
      width: 160,
      render: (_, row) => <span className="audit-operation">{translatedAction(row, t)}</span>,
    },
    {
      title: t("device"),
      width: 180,
      render: (_, row) => (
        <div>
          {row.device_name || (row.device_id ? t("historicalDevice") : t("adminConsole"))}
          <div className="muted audit-device-id">
            {row.device_id || t("adminSession")}
          </div>
        </div>
      ),
    },
    {
      title: t("result"),
      dataIndex: "status",
      width: 110,
      render: (value) => <ResultTag status={value} t={t} />,
    },
    {
      title: t("targetDescription"),
      width: 320,
      render: (_, row) => (
        <div>
          <div className="audit-target" title={row.target}>
            {translatedTarget(row, t)}
          </div>
          <div className="muted audit-summary-text">{translatedDetail(row, t)}</div>
        </div>
      ),
    },
    { title: t("durationLabel"), dataIndex: "duration_ms", width: 100, render: duration },
    {
      title: t("actions"),
      width: 80,
      fixed: "right",
      render: (_, row) => (
        <Button type="link" onClick={() => setSelected(row)}>
          {t("details")}
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("auditTitle")}
        description={t("auditHint")}
        extra={
          <Button
            icon={<RefreshCw size={15} />}
            loading={busy}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </Button>
        }
      />
      <div className="summary-strip audit-summary">
        {(
          [
            [t("filtered"), data.summary.total],
            [t("executionSuccess"), data.summary.success],
            [t("errorsUnknown"), data.summary.errors],
            [t("executing"), data.summary.pending],
          ] as const
        ).map(([label, value]) => (
          <div className="summary-item" key={label}>
            <div>
              <span className="secondary-text">{label}</span>
              <strong>
                {value}
                <small>{t("unitDevice")}</small>
              </strong>
            </div>
          </div>
        ))}
      </div>
      <section className="filter-panel" aria-label={t("auditFilter")}>
        <label className="filter-field">
          <span>{t("keyword")}</span>
          <Input.Search
            aria-label={t("searchAudit")}
            prefix={<Search size={15} />}
            placeholder={t("auditPlaceholder")}
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
          <span>{t("operationType")}</span>
          <Select
            aria-label={t("operationType")}
            value={category}
            onChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
            options={[
              { value: "", label: t("allTypes") },
              { value: "auth", label: t("loginSession") },
              { value: "files", label: t("fileOperations") },
              { value: "shell", label: t("shellCommands") },
              { value: "system", label: t("systemQueries") },
            ]}
          />
        </label>
        <label className="filter-field short">
          <span>{t("result")}</span>
          <Select
            aria-label={t("result")}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: "", label: t("allResults") },
              ...Object.entries(statuses).map(([value, item]) => ({
                value,
                label: t(`auditStatus.${item.key}`),
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
          {t("reset")}
        </Button>
      </section>
      {error && (
        <Alert
          className="page-alert"
          type="error"
          showIcon
          title={t("recordsLoadFailed")}
          description={error}
          action={
            <Button size="small" onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          }
        />
      )}
      <section className="table-panel audit-panel">
        <div className="table-toolbar">
          <div className="toolbar-title">
            {t("auditRecords")}<span className="secondary-text">{t("oneRecordPerOperation")}</span>
          </div>
          <span className="secondary-text">
            {page === 1 ? t("updatesEveryTenSeconds") : t("history")}
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
                description={t("noMatchingRecords")}
              />
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total: data.summary.total,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (total) => t("recordsCount", { count: total }),
            onChange: (next, size) => {
              setPage(size !== pageSize ? 1 : next);
              setPageSize(size);
            },
          }}
        />
        <div className="panel-note">
          <Info size={14} />
          <span>
            {t("auditNote")}
          </span>
        </div>
      </section>
      <Drawer
        title={t("operationDetails")}
        open={!!detail}
        onClose={() => setSelected(null)}
        size={480}
      >
        {detail && (
          <>
            <div className="audit-drawer-title">
              <h2>{translatedAction(detail, t)}</h2>
              <ResultTag status={detail.status} t={t} />
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
              title={translatedDetail(detail, t)}
            />
            <Descriptions
              column={1}
              bordered
              size="small"
              className="audit-description"
              items={[
                { key: "time", label: t("operationTime"), children: date(detail.time) },
                {
                  key: "device",
                  label: t("targetDevice"),
                  children:
                    detail.device_name || detail.device_id || t("adminConsole"),
                },
                {
                  key: "target",
                  label: t("targetDescription"),
                  children: translatedTarget(detail, t),
                },
                {
                  key: "duration",
                  label: t("executionDuration"),
                  children: duration(detail.duration_ms),
                },
                {
                  key: "actor",
                  label: t("operator"),
                  children:
                    detail.status === "denied" && detail.action === "login"
                      ? t("unauthenticatedGuest")
                      : t("administrator"),
                },
                {
                  key: "source",
                  label: t("sourceAddress"),
                  children: detail.source_ip || t("historicalTargetMissing"),
                },
                {
                  key: "trace",
                  label: t("requestId"),
                  children: (
                    <Typography.Text code copyable>
                      {detail.trace_id}
                    </Typography.Text>
                  ),
                },
                {
                  key: "action",
                  label: t("operationId"),
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
