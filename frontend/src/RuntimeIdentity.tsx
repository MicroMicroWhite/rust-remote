import { Alert, Card, Collapse, Descriptions, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";

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
  system: "runtimeSystem", elevated: "runtimeElevated", standard: "runtimeStandard", root: "runtimeRoot", user: "runtimeUser",
};
const integrities: Record<string, string> = {
  untrusted: "integrityUntrusted", low: "integrityLow", medium: "integrityMedium", high: "integrityHigh", system: "integritySystem", protected: "integrityProtected",
};
const states: Record<string, string> = { enabled: "enabled", deny_only: "denyOnly", disabled: "disabled" };
function groupColumns(t: (key: string) => string): ColumnsType<Group> {
 return [
  {
    title: t("groupName"),
    dataIndex: "name",
    render: (name) => name || "—",
  },
  {
    title: t("groupIdSid"),
    dataIndex: "id",
    render: (id) => <span className="mono">{id}</span>,
  },
  {
    title: t("currentState"),
    width: 165,
    render: (_, group) => (
      <>
        {group.primary && <Tag color="blue">{t("primaryGroup")}</Tag>}
        <Tag color={group.state === "enabled" ? "success" : "default"}>
          {states[group.state] ? t(states[group.state]) : group.state}
        </Tag>
      </>
    ),
  },
 ];
}
export default function RuntimeIdentity({
  info,
  platform,
}: {
  info?: IdentityInfo;
  platform: string;
}) {
  const { t } = useTranslation();
  const windows = platform === "windows";
  return (
    <Card
      title={t("identityPermissions")}
      className="detail-card identity-card"
      extra={<span className="secondary-text">{t("currentProcess")}</span>}
    >
      {!info ? (
        <Alert
          type="info"
          showIcon
          title={t("identityMissing")}
          description={t("identityMissingHint")}
        />
      ) : info.error ? (
        <Alert
          type="warning"
          showIcon
          title={t("cannotReadIdentity")}
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
                label: t("account"),
                children: info.account || t("unavailableName"),
              },
              {
                key: "level",
                label: t("privilegeLevel"),
                children: (
                  <Tag color="blue">
                    {levels[info.privilege_level || ""] ? t(levels[info.privilege_level || ""]) : t("notFetchedShort")}
                  </Tag>
                ),
              },
              {
                key: "id",
                label: windows ? t("accountSid") : t("effectiveUid"),
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
                label: windows ? t("integrityLevel") : t("effectiveGid"),
                children: windows
                  ? (integrities[info.integrity || ""] ? t(integrities[info.integrity || ""]) : t("notFetchedShort"))
                  : `${info.egid ?? "—"} / ${info.gid ?? "—"}`,
              },
              ...(info.effective_capabilities
                ? [
                    {
                      key: "cap",
                      label: t("effectiveCapabilities"),
                      children: (
                        <span className="mono">
                          {info.effective_capabilities}{t("hexValue")}
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
                label: t("groups", { count: info.groups?.length ?? 0 }),
                children: (
                  <>
                    <p className="secondary-text group-help">
                      {windows
                        ? t("windowsGroupHint")
                        : t("groupHint")}
                    </p>
                    <Table<Group>
                      rowKey="id"
                      columns={groupColumns(t)}
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
