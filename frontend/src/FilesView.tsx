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
import { useTranslation } from "react-i18next";
import type { Entry, Listing } from "./types";

type Editor = { path: string; content: string; original: string };
export default function FilesView({
  id,
  initialPath,
}: {
  id: string;
  initialPath: string;
}) {
  const { t } = useTranslation();
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
      void message.success(t("operationSuccess"));
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
        title: t("discardChanges"),
        content: t("discardChangesText"),
        okText: t("discardChangesButton"),
        okButtonProps: { danger: true },
        cancelText: t("continueEditing"),
        onOk: () => setEditor(null),
      });
    else setEditor(null);
  }
  async function save() {
    if (!editor) return;
    if (new TextEncoder().encode(editor.content).length > 256 * 1024) {
      void message.error(t("textTooLarge"));
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
      setError(t("uploadTooLarge"));
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
      void message.success(t("uploadSuccess"));
      await load(listing.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const columns: ColumnsType<Entry> = [
    {
      title: t("fileName"),
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
          {entry.is_symlink && <Tag>{t("symlink")}</Tag>}
        </div>
      ),
    },
    {
      title: t("size"),
      dataIndex: "size",
      width: 120,
      sorter: (a, b) => a.size - b.size,
      render: (value, entry) => (entry.is_dir ? "—" : bytes(value)),
    },
    {
      title: t("modified"),
      dataIndex: "modified",
      width: 190,
      sorter: (a, b) => (a.modified || 0) - (b.modified || 0),
      render: (value) => (value ? date(value) : "—"),
    },
    {
      title: t("fileActions"),
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
              {t("download")}
            </Button>
          )}
          {!entry.is_dir && !entry.is_symlink && entry.size <= 256 * 1024 && (
            <Button
              type="link"
              size="small"
              disabled={busy}
              onClick={() => void edit(entry)}
            >
              {t("edit")}
            </Button>
          )}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "rename",
                  label: t("rename"),
                  icon: <Pencil size={14} />,
                  disabled: entry.is_symlink,
                  onClick: () => openNameDialog("rename", entry),
                },
                {
                  key: "delete",
                  label: t("delete"),
                  icon: <Trash2 size={14} />,
                  danger: true,
                  disabled: entry.is_symlink,
                  onClick: () =>
                    modal.confirm({
                      title: t("deleteEntryConfirm", { type: entry.is_dir ? t("directory") : t("fileName") }),
                      content: (
                        <div>
                          <p className="break-word">{entry.name}</p>
                          <p className="secondary-text">
                            {t("deleteEntryNote")}
                          </p>
                        </div>
                      ),
                      okText: t("delete"),
                      okButtonProps: { danger: true },
                      cancelText: t("cancel"),
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
              aria-label={t("moreActions", { name: entry.name })}
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
          {t("fileManagement")}
          <span className="secondary-text">
            {t("itemCount", { count: listing?.entries.length ?? 0 })}
          </span>
        </div>
        <Space wrap>
          <Button
            icon={<Plus size={15} />}
            disabled={busy || !listing}
            onClick={() => openNameDialog("mkdir")}
          >
            {t("newFolder")}
          </Button>
          <Button
            type="primary"
            icon={<Upload size={15} />}
            disabled={busy || !listing}
            onClick={() => input.current?.click()}
          >
            {t("upload")}
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
          <Tooltip title={t("parentDirectory")}>
            <Button
              icon={<ArrowUp size={15} />}
              aria-label={t("parentDirectory")}
              disabled={busy || !listing?.parent}
              onClick={() => listing?.parent && void load(listing.parent)}
            />
          </Tooltip>
          <Input
            aria-label={t("directoryPath")}
            className="mono"
            value={displayPath(path)}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button htmlType="submit" loading={busy}>
            {t("open")}
          </Button>
        </Space.Compact>
        <Tooltip title={t("refreshDirectory")}>
          <Button
            icon={<RefreshCw size={15} />}
            aria-label={t("refreshDirectory")}
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
              description={listing ? t("emptyDirectory") : t("enterPath")}
            />
          ),
        }}
      />
      <div className="panel-note">
        <span>{t("fileNote")}</span>
        {listing?.truncated && <Tag color="warning">{t("truncatedEntries")}</Tag>}
      </div>
      <Modal
        title={dialog?.type === "mkdir" ? t("newFolder") : t("rename")}
        open={!!dialog}
        onCancel={() => {
          if (!busy) setDialog(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        okText={t("confirm")}
        cancelText={t("cancel")}
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
            label={dialog?.type === "mkdir" ? t("folderName") : t("newName")}
            rules={[
              { required: true, whitespace: true, message: t("enterName") },
              {
                validator: (_, value) =>
                  !value ||
                  (!/[\\/\0]/.test(value) && value !== "." && value !== "..")
                    ? Promise.resolve()
                    : Promise.reject(
                        new Error(t("invalidName")),
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
        title={t("editTextFile")}
        open={!!editor}
        width={900}
        onCancel={closeEditor}
        onOk={() => void save()}
        confirmLoading={busy}
        okText={t("saveChanges")}
        cancelText={t("close")}
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
              aria-label={t("fileContentAria")}
              spellCheck={false}
              value={editor.content}
              onChange={(e) =>
                setEditor({ ...editor, content: e.target.value })
              }
              autoSize={{ minRows: 14, maxRows: 24 }}
            />
            <div className="panel-note">
              {t("textFileNote")}
            </div>
          </>
        )}
      </Modal>
    </section>
  );
}
