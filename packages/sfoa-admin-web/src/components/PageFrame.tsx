import type { ReactNode } from 'react';
import { Space, Typography } from 'antd';

export function PageFrame({
  title,
  description,
  action,
  children,
}: Readonly<{ title: string; description: string; action?: ReactNode; children: ReactNode }>) {
  return (
    <section aria-labelledby="page-title" className="page-frame">
      <div className="page-heading">
        <div>
          <Typography.Title id="page-title" level={2}>{title}</Typography.Title>
          <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
        </div>
        {action ? <Space wrap>{action}</Space> : null}
      </div>
      {children}
    </section>
  );
}
