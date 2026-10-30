import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Dropdown,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowUp,
  File,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api, command, download } from "./api";
import { bytes, date } from "./format";
import { displayPath } from "./path";
import { EmptyState, pagination } from "./ui";
import { usePageLoading } from "./PageTransition";
import type { Entry, Listing } from "./types";

type Editor = { path: string; content: string; original: string };
export default function FilesView({
  id,
  initialPath,
}: {
  id: string;
  initialPath: string;
}) {
  const { modal, message } = App.useApp();
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(true);
  usePageLoading(busy);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dialog, setDialog] = useState<{
    type: "mkdir" | "rename";
    entry?: Entry;
  } | null>(null);
  const [form] = Form.useForm<{ name: string }>();
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const load = useCallback(
    async (target: string) => {
      const current = ++generation.current;
      setBusy(true);
      setError("");
      try {
        const data = await command<Listing>(id, "fs.list", { path: target });
        if (current === generation.current) {
          setListing(data);
          setPath(data.path);
          setPage(1);
        }
      } catch (e) {
        if (current === generation.current) setError((e as Error).message);
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    void load(initialPath);
    return () => {
      generation.current++;
    };
  }, [load, initialPath]);
  const join = (name: string) =>
    `${listing?.path.replace(/[\\/]$/, "")}${listing?.path.includes("\\") ? "\\" : "/"}${name}`;
  async function mutate(action: string, params: object) {
    setBusy(true);
    setError("");
    try {
      await command(id, action, params);
      void message.success("操作成功");
      await load(listing?.path || path);
    } catch (e) {
      setError((e as Error).message);
      void message.error((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function openNameDialog(type: "mkdir" | "rename", entry?: Entry) {
    form.resetFields();
    form.setFieldsValue({ name: entry?.name || "" });
    setDialog({ type, entry });
  }
  async function submitName({ name }: { name: string }) {
    if (!dialog) return;
    try {
      if (dialog.type === "mkdir")
        await mutate("fs.mkdir", { path: join(name) });
      else if (name !== dialog.entry!.name)
        await mutate("fs.rename", {
          path: dialog.entry!.path,
          destination: join(name),
        });
      setDialog(null);
    } catch {}
  }
  async function edit(entry: Entry) {
    setBusy(true);
    setError("");
    try {
      const data = await command<{ content: string }>(id, "fs.text", {
        path: entry.path,
      });
      setEditor({
        path: entry.path,
        content: data.content,
        original: data.content,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function closeEditor() {
    if (editor?.content !== editor?.original)
      modal.confirm({
        title: "放弃未保存的修改？",
        content: "关闭后，本次编辑的内容将不会保存。",
        okText: "放弃修改",
        okButtonProps: { danger: true },
        cancelText: "继续编辑",
        onOk: () => setEditor(null),
      });
    else setEditor(null);
  }
  async function save() {
    if (!editor) return;
    if (new TextEncoder().encode(editor.content).length > 256 * 1024) {
      void message.error("文本内容不能超过 256 KiB");
      return;
    }
    try {
      await mutate("fs.edit", { path: editor.path, content: editor.content });
      setEditor(null);
    } catch {}
  }
  async function upload(file?: globalThis.File) {
    if (input.current) input.current.value = "";
    if (!file || !listing) return;
    if (file.size > 8 * 1024 * 1024) {
      setError("上传文件不能超过 8 MiB");
      return;
    }
    const data = new FormData();
    data.append("file", file);
    setBusy(true);
    setError("");
    try {
      await api(
        `/devices/${encodeURIComponent(id)}/upload?path=${encodeURIComponent(join(file.name))}`,
        { method: "POST", body: data },
      );
      void message.success("文件上传成功");
      await load(listing.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const columns: ColumnsType<Entry> = [
    {
      title: "名称",
      key: "name",
      width: 340,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_, entry) => (
        <div className="file-cell">
          {entry.is_dir ? (
            <Folder size={18} className="folder-icon" />
          ) : (
            <File size={18} className="secondary-text" />
          )}
          <Tooltip title={entry.name}>
            {entry.is_dir ? (
              <Button
                type="link"
                className="cell-link"
                disabled={busy}
                onClick={() => void load(entry.path)}
              >
                {entry.name}
              </Button>
            ) : (
              <span className="file-label">{entry.name}</span>
            )}
          </Tooltip>
          {entry.is_symlink && <Tag>链接</Tag>}
        </div>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      width: 120,
      sorter: (a, b) => a.size - b.size,
      render: (value, entry) => (entry.is_dir ? "—" : bytes(value)),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      width: 190,
      sorter: (a, b) => (a.modified || 0) - (b.modified || 0),
      render: (value) => (value ? date(value) : "—"),
    },
    {
      title: "操作",
      width: 200,
      fixed: "right",
      render: (_, entry) => (
        <Space size={4}>
          {!entry.is_dir && (
            <Button
              type="link"
              size="small"
              disabled={busy}
              onClick={() =>
                void download(id, entry.path, entry.name).catch((e) =>
                  setError(e.message),
                )
              }
            >
              下载
            </Button>
          )}
          {!entry.is_dir && !entry.is_symlink && entry.size <= 256 * 1024 && (
            <Button
              type="link"
              size="small"
              disabled={busy}
              onClick={() => void edit(entry)}
            >
              编辑
            </Button>
          )}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "rename",
                  label: "重命名",
                  icon: <Pencil size={14} />,
                  disabled: entry.is_symlink,
                  onClick: () => openNameDialog("rename", entry),
                },
                {
                  key: "delete",
                  label: "删除",
                  icon: <Trash2 size={14} />,
                  danger: true,
                  disabled: entry.is_symlink,
                  onClick: () =>
                    modal.confirm({
                      title: `删除${entry.is_dir ? "目录" : "文件"}？`,
                      content: (
                        <div>
                          <p className="break-word">{entry.name}</p>
                          <p className="secondary-text">
                            此操作不可撤销。目录必须为空。
                          </p>
                        </div>
                      ),
                      okText: "删除",
                      okButtonProps: { danger: true },
                      cancelText: "取消",
                      onOk: () => mutate("fs.delete", { path: entry.path }),
                    }),
                },
              ],
            }}
          >
            <Button
              type="text"
              size="small"
              disabled={busy}
              aria-label={`更多操作 ${entry.name}`}
              icon={<MoreHorizontal size={16} />}
            />
          </Dropdown>
        </Space>
      ),
    },
  ];
  return (
    <section className="table-panel files-panel">
      <div className="table-toolbar">
        <div className="toolbar-title">
          文件管理
          <span className="secondary-text">
            {listing?.entries.length ?? 0} 个项目
          </span>
        </div>
        <Space wrap>
          <Button
            icon={<Plus size={15} />}
            disabled={busy || !listing}
            onClick={() => openNameDialog("mkdir")}
          >
            新建文件夹
          </Button>
          <Button
            type="primary"
            icon={<Upload size={15} />}
            disabled={busy || !listing}
            onClick={() => input.current?.click()}
          >
            上传文件
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </Space>
      </div>
      <form
        className="path-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void load(path);
        }}
      >
        <Space.Compact block>
          <Tooltip title="上一级目录">
            <Button
              icon={<ArrowUp size={15} />}
              aria-label="上一级目录"
              disabled={busy || !listing?.parent}
              onClick={() => listing?.parent && void load(listing.parent)}
            />
          </Tooltip>
          <Input
            aria-label="目录路径"
            className="mono"
            value={displayPath(path)}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button htmlType="submit" loading={busy}>
            打开
          </Button>
        </Space.Compact>
        <Tooltip title="刷新目录">
          <Button
            icon={<RefreshCw size={15} />}
            aria-label="刷新目录"
            disabled={busy}
            onClick={() => void load(listing?.path || path)}
          />
        </Tooltip>
      </form>
      {error && (
        <Alert
          className="inline-alert"
          type="error"
          showIcon
          title={error}
          closable
          onClose={() => setError("")}
        />
      )}
      <Table<Entry>
        rowKey="path"
        columns={columns}
        dataSource={listing?.entries ?? []}
        loading={busy}
        size="small"
        scroll={{ x: 850 }}
        pagination={{ ...pagination, current: page, onChange: setPage }}
        locale={{
          emptyText: (
            <EmptyState
              description={listing ? "此目录为空" : "输入目录路径后打开"}
            />
          ),
        }}
      />
      <div className="panel-note">
        <span>单文件最大 8 MiB，上传不覆盖同名文件。</span>
        {listing?.truncated && <Tag color="warning">仅显示前 5000 项</Tag>}
      </div>
      <Modal
        title={dialog?.type === "mkdir" ? "新建文件夹" : "重命名"}
        open={!!dialog}
        onCancel={() => {
          if (!busy) setDialog(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        okText="确定"
        cancelText="取消"
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={submitName}
          requiredMark={false}
          className="dialog-form"
        >
          <Form.Item
            name="name"
            label={dialog?.type === "mkdir" ? "文件夹名称" : "新名称"}
            rules={[
              { required: true, whitespace: true, message: "请输入名称" },
              {
                validator: (_, value) =>
                  !value ||
                  (!/[\\/\0]/.test(value) && value !== "." && value !== "..")
                    ? Promise.resolve()
                    : Promise.reject(
                        new Error("名称不能包含路径分隔符，也不能为 . 或 .."),
                      ),
              },
            ]}
          >
            <Input
              autoFocus
              maxLength={255}
              onPressEnter={(e) => {
                e.preventDefault();
                if (!busy) form.submit();
              }}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="编辑文本文件"
        open={!!editor}
        width={900}
        onCancel={closeEditor}
        onOk={() => void save()}
        confirmLoading={busy}
        okText="保存更改"
        cancelText="关闭"
        cancelButtonProps={{ disabled: busy }}
        okButtonProps={{
          disabled: !editor || editor.content === editor.original,
        }}
        maskClosable={false}
      >
        {editor && (
          <>
            <Typography.Paragraph className="editor-path mono" copyable>
              {displayPath(editor.path)}
            </Typography.Paragraph>
            <Input.TextArea
              className="file-editor"
              aria-label="文件内容"
              spellCheck={false}
              value={editor.content}
              onChange={(e) =>
                setEditor({ ...editor, content: e.target.value })
              }
              autoSize={{ minRows: 14, maxRows: 24 }}
            />
            <div className="panel-note">
              UTF-8 文本 · 最大 256 KiB · 保存会替换原文件内容
            </div>
          </>
        )}
      </Modal>
    </section>
  );
}
