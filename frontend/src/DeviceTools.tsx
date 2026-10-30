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
import type { EnvironmentVariable, Output, Process } from "./types";
import TerminalView from "./TerminalView";
import { parsePorts, type PortConnection } from "./ports";

type Props = { id: string; setError: (error: string) => void };
export { default as ScreenView } from "./ScreenView";
export function ProcessesView({ id, setError, killSupported }: Props & { killSupported: boolean }) {
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
      title: "进程名称",
      dataIndex: "name",
      sorter: (a, b) => a.name.localeCompare(b.name),
      ellipsis: true,
    },
    {
      title: "内存占用",
      dataIndex: "memory",
      width: 180,
      sorter: (a, b) => a.memory - b.memory,
      render: bytes,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 180,
      render: (value) => <Tag>{value}</Tag>,
    },
    {
      title: "操作", key: "actions", width: 120,
      render: (_, process) => <Button size="small" danger type="link"
        disabled={!killSupported || process.can_kill === false || process.start_time === undefined}
        onClick={() => { setSelected(process); setEndError(""); }}>结束进程</Button>,
    },
  ];
  return (
    <section className="table-panel">
      <Modal title="结束进程" open={!!selected} okText="结束进程" cancelText="取消"
        okButtonProps={{ danger: true }} confirmLoading={ending} cancelButtonProps={{ disabled: ending }}
        closable={!ending} maskClosable={!ending} keyboard={!ending}
        onCancel={() => { if (!ending) setSelected(null); }} onOk={() => void terminate()}>
        <p className="process-confirm">确定结束 <strong>{selected?.name}</strong>（PID {selected?.pid}）？</p>
        <p className="secondary-text">进程将立即终止，未保存的数据可能丢失。请确认这是需要结束的进程。</p>
        {endError && <Alert className="form-alert" type="error" showIcon title="未能结束进程" description={endError} />}
      </Modal>
      <div className="table-toolbar">
        <div className="toolbar-title">
          进程列表<span className="secondary-text">{items.length} 个进程</span>
        </div>
        <div className="toolbar-actions">
          <Input
            aria-label="搜索进程"
            prefix={<Search size={14} />}
            placeholder="搜索名称或 PID"
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
            刷新
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
        locale={{ emptyText: <EmptyState description="没有匹配的进程" /> }}
      />
      {truncated && <div className="panel-note">仅显示前 10000 个进程。</div>}
      {!killSupported && <div className="panel-note">升级被控端后可使用结束进程功能。</div>}
    </section>
  );
}
export function EnvironmentView({ id, setError }: Props) {
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
      title: "变量名",
      dataIndex: "name",
      width: 280,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (value) => <span className="mono" title={value}>{value}</span>,
    },
    {
      title: "变量值",
      dataIndex: "value",
      ellipsis: true,
      render: (value) => <span className="mono" title={value}>{value || "—"}</span>,
    },
  ];
  return (
    <section className="table-panel">
      <div className="table-toolbar">
        <div className="toolbar-title">
          环境变量<span className="secondary-text">{filtered.length} / {items.length} 个变量</span>
        </div>
        <div className="toolbar-actions">
          <Input
            aria-label="搜索环境变量"
            prefix={<Search size={14} />}
            placeholder="搜索变量名或值"
            allowClear
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
          <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void refresh()}>
            刷新
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
        locale={{ emptyText: <EmptyState description={query ? "没有匹配的环境变量" : "未发现环境变量"} /> }}
      />
      <div className="panel-note">
        显示被控端当前进程的环境变量。
        {truncated ? "环境变量数量超过上限，仅显示前 2000 个。" : ""}
      </div>
    </section>
  );
}
export function PortsView({ id, setError }: Props) {
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
      if (output.exit_code !== 0) throw new Error(output.stderr || "未能读取端口信息，请检查被控端权限及网络工具。");
      const parsed = parsePorts(output.stdout);
      setItems(parsed.items);
      setPage(1);
      setNote([output.truncated ? "输出已截断，部分连接可能未显示。" : "",
        parsed.unparsed ? `${parsed.unparsed} 行连接无法识别。` : "", output.stderr].filter(Boolean).join(" "));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [id, setError]);
  useEffect(() => { void refresh(); }, [refresh]);
  const filtered = items.filter((item) => (!protocol || item.protocol.startsWith(protocol)) &&
    `${item.local} ${item.remote} ${item.state} ${item.pid ?? ""} ${item.process}`.toLowerCase().includes(query.trim().toLowerCase()));
  const columns: ColumnsType<PortConnection> = [
    { title: "协议", dataIndex: "protocol", width: 90, render: (value) => <Tag>{value}</Tag> },
    { title: "本地地址 / 端口", dataIndex: "local", width: 240, sorter: (a, b) => a.local.localeCompare(b.local),
      render: (value) => <span className="mono">{value}</span> },
    { title: "远程地址 / 端口", dataIndex: "remote", width: 240, sorter: (a, b) => a.remote.localeCompare(b.remote),
      render: (value) => <span className="mono">{value}</span> },
    { title: "状态", dataIndex: "state", width: 155, sorter: (a, b) => a.state.localeCompare(b.state),
      render: (value) => <Tag color={/LISTEN/.test(value) ? "blue" : /ESTAB|已建立/.test(value) ? "success" : "default"}>{value}</Tag> },
    { title: "PID", dataIndex: "pid", width: 100, sorter: (a, b) => (a.pid ?? -1) - (b.pid ?? -1),
      render: (value) => <span className="mono">{value ?? "—"}</span> },
    { title: "进程名称", dataIndex: "process", width: 160, ellipsis: true, render: (value) => value || "—" },
  ];
  return <section className="table-panel">
    <div className="table-toolbar">
      <div className="toolbar-title">端口与网络连接<span className="secondary-text">{filtered.length} / {items.length} 条连接</span></div>
      <div className="toolbar-actions">
        <Input aria-label="搜索端口连接" prefix={<Search size={14} />} placeholder="地址、端口、PID 或进程" allowClear
          value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
        <Select aria-label="协议筛选" className="port-protocol-filter" value={protocol}
          onChange={(value) => { setProtocol(value); setPage(1); }}
          options={[{ value: "", label: "全部协议" }, { value: "TCP", label: "TCP" }, { value: "UDP", label: "UDP" }]} />
        <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void refresh()}>刷新</Button>
      </div>
    </div>
    <Table<PortConnection> rowKey="key" columns={columns} dataSource={filtered} loading={busy} size="small"
      scroll={{ x: 1000 }} pagination={{ ...pagination, current: page, onChange: setPage }}
      locale={{ emptyText: <EmptyState description={query || protocol ? "没有匹配的连接" : "未发现网络连接"} /> }} />
    <div className="panel-note">进程归属信息取决于被控端账户权限。{note}</div>
  </section>;
}
export function ShellView(props: Props & { disabled: boolean; interactive: boolean }) {
  return props.interactive ? <TerminalView id={props.id} disabled={props.disabled} /> : <>
    <div className="panel-note">此设备使用单次命令模式，升级被控端后可使用连续交互式终端。</div>
    <LegacyShellView {...props} />
  </>;
}
function LegacyShellView({
  id,
  disabled,
  setError,
}: Props & { disabled: boolean }) {
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
          终端命令<Tag>超时 30 秒</Tag>
        </div>
        <Button
          disabled={busy || !history.length}
          onClick={() => setHistory([])}
        >
          清空显示
        </Button>
      </div>
      <div className="shell-output" aria-label="命令执行结果" role="log">
        {!history.length && (
          <div className="terminal-placeholder">
            <Terminal size={24} />
            <p>{disabled ? "此设备的终端命令功能不可用。" : "等待执行命令"}</p>
            <span>每条命令独立执行，工作目录不会跨命令保存。</span>
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
              退出码 {item.output.exit_code ?? "—"}
              {item.output.truncated && " · 输出已截断"}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="shell-form" onSubmit={run}>
        <Input
          aria-label="Shell 命令"
          prefix={<Terminal size={15} />}
          className="mono"
          value={text}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? "终端命令不可用" : "输入命令，按 Enter 执行"}
          autoComplete="off"
        />
        <Button
          htmlType="submit"
          type="primary"
          loading={busy}
          disabled={disabled || !text.trim()}
        >
          执行命令
        </Button>
      </form>
      <div className="panel-note">
        <Typography.Text type="secondary">
          以客户端当前账户权限执行。仅保留本页最近 20 次输出。
        </Typography.Text>
      </div>
    </section>
  );
}
