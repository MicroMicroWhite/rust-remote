import type { ReactNode } from "react";
import { Badge, Empty, Spin } from "antd";

export function PageHeader({
  title,
  description,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <div className="page-description">{description}</div>}
      </div>
      {extra && <div className="page-actions">{extra}</div>}
    </div>
  );
}
export function DeviceStatus({ online }: { online: boolean }) {
  return (
    <Badge
      status={online ? "success" : "default"}
      text={online ? "在线" : "离线"}
    />
  );
}
export function Loading() {
  return (
    <div className="loading-state">
      <Spin />
      <span>正在加载…</span>
    </div>
  );
}
export function EmptyState({ description }: { description: ReactNode }) {
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />
  );
}
export const pagination = {
  defaultPageSize: 20,
  showSizeChanger: true,
  pageSizeOptions: [20, 50, 100],
  showTotal: (total: number) => `共 ${total} 条`,
};
