import { useState } from 'react';
import { Typography } from 'antd';

/** Untrusted text, rendered as text. Long text is cut with a "show more" toggle. */
export function TextBlock({ text, limit = 400, mono = true, type }: { text: string; limit?: number; mono?: boolean; type?: 'danger' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <Typography.Text type={type} className={mono ? 'mono' : undefined} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: mono ? 12 : undefined }}>
      {long && !open ? `${text.slice(0, limit)}…` : text}
      {long && (
        <Typography.Link style={{ marginLeft: 6, fontSize: 12 }} onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </Typography.Link>
      )}
    </Typography.Text>
  );
}
