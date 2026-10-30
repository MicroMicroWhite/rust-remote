import { Alert, Card, Collapse, Descriptions, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";

type Group = {
  id: string;
  name: string | null;
  state: string;
  primary?: boolean;
};
export type IdentityInfo = {
  account?: string | null;
  account_id?: string;
  privilege_level?: string;
  uid?: number;
  euid?: number;
  gid?: number;
  egid?: number;
  integrity?: string;
  effective_capabilities?: string | null;
  groups?: Group[];
  error?: string;
};
const levels: Record<string, string> = {
  system: "SYSTEM 系统账户",
  elevated: "管理员 · 已提权",
  standard: "普通 / 受限令牌 · 未提权",
  root: "root 用户",
  user: "普通用户",
};
const integrities: Record<string, string> = {
  untrusted: "不可信",
  low: "低",
  medium: "中",
  high: "高",
  system: "系统",
  protected: "受保护",
};
const states: Record<string, string> = {
  enabled: "已启用",
  deny_only: "仅拒绝",
  disabled: "未启用",
};
const columns: ColumnsType<Group> = [
  {
    title: "组名称",
    dataIndex: "name",
    render: (name) => name || "名称不可用",
  },
  {
    title: "组 ID / SID",
    dataIndex: "id",
    render: (id) => <span className="mono">{id}</span>,
  },
  {
    title: "当前状态",
    width: 165,
    render: (_, group) => (
      <>
        {group.primary && <Tag color="blue">主组</Tag>}
        <Tag color={group.state === "enabled" ? "success" : "default"}>
          {states[group.state] || group.state}
        </Tag>
      </>
    ),
  },
];
export default function RuntimeIdentity({
  info,
  platform,
}: {
  info?: IdentityInfo;
  platform: string;
}) {
  const windows = platform === "windows";
  return (
    <Card
      title="运行身份与权限"
      className="detail-card identity-card"
      extra={<span className="secondary-text">当前进程</span>}
    >
      {!info ? (
        <Alert
          type="info"
          showIcon
          title="当前客户端未上报运行身份"
          description="手动替换新版客户端并重新连接后，可查看运行账户和组信息。"
        />
      ) : info.error ? (
        <Alert
          type="warning"
          showIcon
          title="无法读取运行身份"
          description={info.error}
        />
      ) : (
        <>
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2, xxl: 2 }}
            items={[
              {
                key: "account",
                label: "运行账户",
                children: info.account || "名称不可用",
              },
              {
                key: "level",
                label: "权限级别",
                children: (
                  <Tag color="blue">
                    {levels[info.privilege_level || ""] || "未获取"}
                  </Tag>
                ),
              },
              {
                key: "id",
                label: windows ? "账户 SID" : "有效 / 实际 UID",
                children: (
                  <span className="mono">
                    {windows
                      ? info.account_id
                      : `${info.euid ?? "—"} / ${info.uid ?? "—"}`}
                  </span>
                ),
              },
              {
                key: "integrity",
                label: windows ? "完整性级别" : "有效 / 实际 GID",
                children: windows
                  ? integrities[info.integrity || ""] || "未获取"
                  : `${info.egid ?? "—"} / ${info.gid ?? "—"}`,
              },
              ...(info.effective_capabilities
                ? [
                    {
                      key: "cap",
                      label: "有效 capabilities",
                      children: (
                        <span className="mono">
                          {info.effective_capabilities}（十六进制）
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          <Collapse
            ghost
            className="identity-groups"
            items={[
              {
                key: "groups",
                label: `所属组（${info.groups?.length ?? 0}）`,
                children: (
                  <>
                    <p className="secondary-text group-help">
                      {windows
                        ? "“仅拒绝”组不授予访问权限。属于管理员组不代表当前进程已提权。"
                        : "显示进程的有效主组和附加组，实际权限还受 capabilities、容器与文件权限限制。"}
                    </p>
                    <Table<Group>
                      rowKey="id"
                      columns={columns}
                      dataSource={info.groups ?? []}
                      size="small"
                      pagination={false}
                      scroll={{ x: 600, y: 280 }}
                    />
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}
