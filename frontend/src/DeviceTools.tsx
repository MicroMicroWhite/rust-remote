import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Alert, Button, Input, Modal, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { RefreshCw, Search, Terminal } from "lucide-react";
import { command } from "./api";
import { bytes } from "./format";
import { EmptyState, pagination } from "./ui";
import { usePageLoading } from "./PageTransition";
import { useTranslation } from "react-i18next";
import type { EnvironmentVariable, Output, Process } from "./types";
import TerminalView from "./TerminalView";
import { parsePorts, type PortConnection } from "./ports";

type Props = { id: string; setError: (error: string) => void };
export { default as ScreenView } from "./ScreenView";
export function ProcessesView({ id, setError, killSupported }: Props & { killSupported: boolean }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Process[]>([]);
  const [busy, setBusy] = useState(true);
  usePageLoading(busy);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<Process | null>(null);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await command<{
        processes: Process[];
        truncated: boolean;
      }>(id, "process.list");
      setItems(result.processes);
      setTruncated(result.truncated);
      setPage(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [id, setError]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function terminate() {
    if (!selected || ending) return;
    setEnding(true);
    setEndError("");
    try {
      await command(id, "process.kill", { pid: selected.pid, start_time: selected.start_time });
      setSelected(null);
      await refresh();
    } catch (e) {
      setEndError((e as Error).message);
    } finally { setEnding(false); }
  }
  const columns: ColumnsType<Process> = [
    {
      title: "PID",
      dataIndex: "pid",
      width: 130,
      sorter: (a, b) => a.pid - b.pid,
      render: (value) => <span className="mono">{value}</span>,
    },
    {
      title: t("portProcess"),
      dataIndex: "name",
      sorter: (a, b) => a.name.localeCompare(b.name),
      ellipsis: true,
    },
    {
      title: t("memory"),
      dataIndex: "memory",
      width: 180,
      sorter: (a, b) => a.memory - b.memory,
      render: bytes,
    },
    {
      title: t("status"),
      dataIndex: "status",
      width: 180,
      render: (value) => <Tag>{value}</Tag>,
    },
    {
      title: t("actions"), key: "actions", width: 120,
      render: (_, process) => <Button size="small" danger type="link"
        disabled={!killSupported || process.can_kill === false || process.start_time === undefined}
        onClick={() => { setSelected(process); setEndError(""); }}>{t("endProcess")}</Button>,
    },
  ];
  return (
    <section className="table-panel">
      <Modal title={t("endProcess")} open={!!selected} okText={t("endProcess")} cancelText={t("cancel")}
        okButtonProps={{ danger: true }} confirmLoading={ending} cancelButtonProps={{ disabled: ending }}
        closable={!ending} maskClosable={!ending} keyboard={!ending}
        onCancel={() => { if (!ending) setSelected(null); }} onOk={() => void terminate()}>
        <p className="process-confirm">{t("endProcessConfirm", { name: selected?.name, pid: selected?.pid })}</p>
        <p className="secondary-text">{t("endProcessNote")}</p>
        {endError && <Alert className="form-alert" type="error" showIcon title={t("cannotEndProcess")} description={endError} />}
      </Modal>
      <div className="table-toolbar">
        <div className="toolbar-title">
          {t("processList")}<span className="secondary-text">{t("processCount", { count: items.length })}</span>
        </div>
        <div className="toolbar-actions">
          <Input
            aria-label={t("searchProcesses")}
            prefix={<Search size={14} />}
            placeholder={t("processPlaceholder")}
            allowClear
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
          <Button
            icon={<RefreshCw size={14} />}
            loading={busy}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </Button>
        </div>
      </div>
      <Table<Process>
        rowKey="pid"
        columns={columns}
        dataSource={items.filter((p) =>
          `${p.pid} ${p.name}`.toLowerCase().includes(query.toLowerCase()),
        )}
        loading={busy}
        size="small"
        scroll={{ x: 800 }}
        pagination={{ ...pagination, current: page, onChange: setPage }}
        locale={{ emptyText: <EmptyState description={t("noMatchingProcesses")} /> }}
      />
      {truncated && <div className="panel-note">{t("processLimit")}</div>}
      {!killSupported && <div className="panel-note">{t("killUpgrade")}</div>}
    </section>
  );
}
export function EnvironmentView({ id, setError }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<EnvironmentVariable[]>([]);
  const [busy, setBusy] = useState(true);
  usePageLoading(busy);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [truncated, setTruncated] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await command<{
        variables: EnvironmentVariable[];
        truncated: boolean;
      }>(id, "system.environment");
      setItems(result.variables);
      setTruncated(result.truncated);
      setPage(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [id, setError]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const filtered = items.filter((item) =>
    `${item.name} ${item.value}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const columns: ColumnsType<EnvironmentVariable> = [
    {
      title: t("variableName"),
      dataIndex: "name",
      width: 280,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (value) => <span className="mono" title={value}>{value}</span>,
    },
    {
      title: t("variableValue"),
      dataIndex: "value",
      ellipsis: true,
      render: (value) => <span className="mono" title={value}>{value || "—"}</span>,
    },
  ];
  return (
    <section className="table-panel">
      <div className="table-toolbar">
        <div className="toolbar-title">
          {t("environmentVariables")}<span className="secondary-text">{t("environmentCount", { filtered: filtered.length, total: items.length })}</span>
        </div>
        <div className="toolbar-actions">
          <Input
            aria-label={t("searchEnvironment")}
            prefix={<Search size={14} />}
            placeholder={t("environmentPlaceholder")}
            allowClear
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
          <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void refresh()}>
            {t("refresh")}
          </Button>
        </div>
      </div>
      <Table<EnvironmentVariable>
        rowKey="name"
        columns={columns}
        dataSource={filtered}
        loading={busy}
        size="small"
        scroll={{ x: 700 }}
        pagination={{ ...pagination, current: page, onChange: setPage }}
        locale={{ emptyText: <EmptyState description={query ? t("noMatchingEnvironment") : t("noEnvironment")} /> }}
      />
      <div className="panel-note">
        {t("environmentNote")}
        {truncated ? t("environmentLimit") : ""}
      </div>
    </section>
  );
}
export function PortsView({ id, setError }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PortConnection[]>([]);
  const [busy, setBusy] = useState(true);
  usePageLoading(busy);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("");
  const [page, setPage] = useState(1);
  const [note, setNote] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const output = await command<Output>(id, "ports.list");
      if (output.exit_code !== 0) throw new Error(output.stderr || t("readPortsFailed"));
      const parsed = parsePorts(output.stdout);
      setItems(parsed.items);
      setPage(1);
      setNote([output.truncated ? t("outputTruncated") : "",
        parsed.unparsed ? t("unparsedConnections", { count: parsed.unparsed }) : "", output.stderr].filter(Boolean).join(" "));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [id, setError]);
  useEffect(() => { void refresh(); }, [refresh]);
  const filtered = items.filter((item) => (!protocol || item.protocol.startsWith(protocol)) &&
    `${item.local} ${item.remote} ${item.state} ${item.pid ?? ""} ${item.process}`.toLowerCase().includes(query.trim().toLowerCase()));
  const columns: ColumnsType<PortConnection> = [
    { title: t("protocol"), dataIndex: "protocol", width: 90, render: (value) => <Tag>{value}</Tag> },
    { title: t("localAddressPort"), dataIndex: "local", width: 240, sorter: (a, b) => a.local.localeCompare(b.local),
      render: (value) => <span className="mono">{value}</span> },
    { title: t("remoteAddressPort"), dataIndex: "remote", width: 240, sorter: (a, b) => a.remote.localeCompare(b.remote),
      render: (value) => <span className="mono">{value}</span> },
    { title: t("status"), dataIndex: "state", width: 155, sorter: (a, b) => a.state.localeCompare(b.state),
      render: (value) => <Tag color={/LISTEN/.test(value) ? "blue" : /ESTAB|\u5df2\u5efa\u7acb/.test(value) ? "success" : "default"}>{value}</Tag> },
    { title: "PID", dataIndex: "pid", width: 100, sorter: (a, b) => (a.pid ?? -1) - (b.pid ?? -1),
      render: (value) => <span className="mono">{value ?? "—"}</span> },
    { title: t("portProcess"), dataIndex: "process", width: 160, ellipsis: true, render: (value) => value || "—" },
  ];
  return <section className="table-panel">
    <div className="table-toolbar">
      <div className="toolbar-title">{t("portConnectionsTitle")}<span className="secondary-text">{t("connectionCount", { filtered: filtered.length, total: items.length })}</span></div>
      <div className="toolbar-actions">
        <Input aria-label={t("searchPorts")} prefix={<Search size={14} />} placeholder={t("portPlaceholder")} allowClear
          value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
        <Select aria-label={t("protocolFilter")} className="port-protocol-filter" value={protocol}
          onChange={(value) => { setProtocol(value); setPage(1); }}
          options={[{ value: "", label: t("allProtocols") }, { value: "TCP", label: "TCP" }, { value: "UDP", label: "UDP" }]} />
        <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void refresh()}>{t("refresh")}</Button>
      </div>
    </div>
    <Table<PortConnection> rowKey="key" columns={columns} dataSource={filtered} loading={busy} size="small"
      scroll={{ x: 1000 }} pagination={{ ...pagination, current: page, onChange: setPage }}
      locale={{ emptyText: <EmptyState description={query || protocol ? t("noMatchingConnections") : t("noNetworkConnections")} /> }} />
    <div className="panel-note">{t("portNote")}{note}</div>
  </section>;
}
export function ShellView(props: Props & { disabled: boolean; interactive: boolean }) {
  const { t } = useTranslation();
  return props.interactive ? <TerminalView id={props.id} disabled={props.disabled} /> : <>
    <div className="panel-note">{t("terminalSingleCommandNote")}</div>
    <LegacyShellView {...props} />
  </>;
}
function LegacyShellView({
  id,
  disabled,
  setError,
}: Props & { disabled: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ command: string; output: Output }[]>(
    [],
  );
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (history.length) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [history]);
  async function run(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy || disabled) return;
    const submitted = text;
    setBusy(true);
    try {
      const output = await command<Output>(id, "shell.exec", {
        command: submitted,
        timeout: 30,
      });
      setHistory((h) => [...h.slice(-19), { command: submitted, output }]);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="table-panel terminal-panel">
      <div className="table-toolbar">
        <div className="toolbar-title">
          <Terminal size={17} />
          {t("terminalCommand")}<Tag>{t("timeoutSeconds")}</Tag>
        </div>
        <Button
          disabled={busy || !history.length}
          onClick={() => setHistory([])}
        >
          {t("clearDisplay")}
        </Button>
      </div>
      <div className="shell-output" aria-label={t("commandResult")} role="log">
        {!history.length && (
          <div className="terminal-placeholder">
            <Terminal size={24} />
            <p>{disabled ? t("terminalUnavailable") : t("waitingForCommand")}</p>
            <span>{t("commandWorkingDirNote")}</span>
          </div>
        )}
        {history.map((item, index) => (
          <div className="command-result" key={index}>
            <div className="shell-command">
              <span>$</span>
              {item.command}
            </div>
            <pre>{item.output.stdout}</pre>
            {item.output.stderr && (
              <pre className="stderr">{item.output.stderr}</pre>
            )}
            <div
              className={`exit-code ${item.output.exit_code !== 0 ? "failed" : ""}`}
            >
              {t("exitCode")} {item.output.exit_code ?? "—"}
              {item.output.truncated && ` · ${t("outputTruncatedInline")}`}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="shell-form" onSubmit={run}>
        <Input
          aria-label={t("shellCommand")}
          prefix={<Terminal size={15} />}
          className="mono"
          value={text}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? t("terminalCommandUnavailable") : t("enterCommand")}
          autoComplete="off"
        />
        <Button
          htmlType="submit"
          type="primary"
          loading={busy}
          disabled={disabled || !text.trim()}
        >
          {t("executeCommand")}
        </Button>
      </form>
      <div className="panel-note">
        <Typography.Text type="secondary">
          {t("shellPermissionNote")}
        </Typography.Text>
      </div>
    </section>
  );
}
