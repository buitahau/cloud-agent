import { useState } from 'react';
import { Button } from 'antd';

/** Untrusted text, rendered as text. Long text is cut with a "show more" toggle. */
export function TextBlock({ text, limit = 400, mono = false, className = 'ev-text', style }: { text: string; limit?: number; mono?: boolean; className?: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <div className={`${className}${mono ? ' mono' : ''}`} style={style}>
      {long && !open ? `${text.slice(0, limit).trimEnd()}…` : text}
      {long && (
        <div>
          <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setOpen(!open)}>
            {open ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
          </Button>
        </div>
      )}
    </div>
  );
}
