import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Checkbox, Empty, Flex, Switch, Tag, Typography, theme } from 'antd';
import { EVENT_TYPES, type EventType, type JobEvent } from '../api/types';
import { describe, label } from '../lib/format';
import { StatusTag } from './StatusTag';
import { TextBlock } from './TextBlock';

const TYPE_COLOR: Record<EventType, string> = {
  status: 'blue',
  init: 'geekblue',
  assistant_text: 'green',
  thinking: 'purple',
  tool_use: 'gold',
  tool_result: 'orange',
  log: 'default',
  gap: 'default',
  result: 'magenta',
};

const Row = memo(function Row({ ev }: { ev: JobEvent }) {
  let body: React.ReactNode;
  switch (ev.type) {
    case 'gap':
      return <Alert type="info" banner title={describe(ev.type, ev.data)} style={{ margin: '4px 0' }} />;
    case 'result':
      return (
        <Alert
          type={ev.data.status === 'succeeded' ? 'success' : 'error'}
          showIcon
          style={{ margin: '4px 0' }}
          title={<StatusTag status={ev.data.status} />}
          description={ev.data.error ? <TextBlock text={ev.data.error} /> : null}
        />
      );
    case 'thinking':
      body = <Typography.Text type="secondary" italic><TextBlock text={describe(ev.type, ev.data)} mono={false} type="secondary" /></Typography.Text>;
      break;
    case 'assistant_text':
      body = <TextBlock text={ev.data.text ?? ''} mono={false} limit={1200} />;
      break;
    case 'tool_use':
      body = (
        <>
          <Tag>{ev.data.name ?? '?'}</Tag>
          <TextBlock text={JSON.stringify(ev.data.input ?? {}, null, 1)} limit={200} />
        </>
      );
      break;
    case 'tool_result':
      body = <TextBlock text={ev.data.text ?? ''} type={ev.data.is_error ? 'danger' : undefined} limit={300} />;
      break;
    case 'status':
      body = <><StatusTag status={ev.data.status} /> <Typography.Text type="secondary">from {ev.data.from ?? '—'}</Typography.Text></>;
      break;
    default:
      body = <TextBlock text={describe(ev.type, ev.data as never)} />;
  }
  return (
    <Flex gap={8} align="baseline" style={{ padding: '3px 0' }}>
      <Typography.Text type="secondary" className="mono" style={{ width: 44, flex: 'none', fontSize: 12, textAlign: 'right' }}>
        {ev.seq !== null ? `#${ev.seq}` : ''}
      </Typography.Text>
      <Tag color={TYPE_COLOR[ev.type]} style={{ flex: 'none', minWidth: 96, textAlign: 'center' }}>
        {ev.type === 'tool_result' && ev.data.is_error ? 'tool error' : label(ev.type)}
      </Tag>
      <div style={{ minWidth: 0, flex: 1 }}>{body}</div>
    </Flex>
  );
});

export function EventStream({ events }: { events: JobEvent[] }) {
  const { token } = theme.useToken();
  const [hidden, setHidden] = useState<EventType[]>([]);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const shown = useMemo(() => events.filter((e) => !hidden.includes(e.type)), [events, hidden]);
  const present = useMemo(() => EVENT_TYPES.filter((t) => events.some((e) => e.type === t)), [events]);

  // Only auto-scroll when the user is already at the bottom (so reading earlier events isn't interrupted).
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown, follow]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);

  return (
    <>
      <Flex gap={16} wrap align="center" style={{ marginBottom: 8 }}>
        <Checkbox.Group
          value={present.filter((t) => !hidden.includes(t))}
          options={present.map((t) => ({ value: t, label: label(t) }))}
          onChange={(v) => setHidden(present.filter((t) => !v.includes(t)))}
        />
        <Flex gap={6} align="center" style={{ marginLeft: 'auto' }}>
          <Switch size="small" checked={follow} onChange={setFollow} />
          <Typography.Text type="secondary">auto-scroll</Typography.Text>
        </Flex>
      </Flex>
      <div
        ref={box}
        style={{ maxHeight: 520, overflow: 'auto', border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, padding: '4px 8px' }}
      >
        {shown.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No events yet" /> : shown.map((e) => <Row key={e.key} ev={e} />)}
      </div>
    </>
  );
}
