import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, enc } from '../api/client';
import { keys } from '../api/queries';
import { EVENT_TYPES, type JobEvent } from '../api/types';

const MAX_EVENTS = 2000; // matches the server's per-job event buffer

/**
 * Live job events over SSE. The server replays buffered events first, then streams until `result`.
 * - Dedupes by seq across the browser's automatic reconnects (it resends Last-Event-ID itself).
 * - Batches state updates once per animation frame so a burst of log lines is one render.
 * - Closes on `result` (and refreshes the job + lists), and on error once the job is terminal — the server
 *   ends a finished job's stream after replay, which would otherwise make EventSource reconnect forever.
 *
 * @param enabled  open the stream (pass true once the job has loaded)
 * @param terminal whether the job already finished when the page loaded
 */
export function useJobEvents(jobId: string, enabled: boolean, terminal: boolean) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [live, setLive] = useState(false);
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;

  useEffect(() => {
    if (!enabled) return;
    setEvents([]);
    let lastSeq = 0;
    let gapN = 0;
    let pending: JobEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setEvents((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    const es = new EventSource(`${API_BASE}/jobs/${enc(jobId)}/events`);
    setLive(!terminalRef.current);
    const close = () => {
      es.close();
      setLive(false);
    };

    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        const msg = e as MessageEvent<string>;
        const seq = msg.lastEventId ? Number(msg.lastEventId) : null;
        if (seq !== null && type !== 'gap') {
          if (seq <= lastSeq) return; // replayed after reconnect
          lastSeq = seq;
        }
        let data: unknown = {};
        try {
          data = JSON.parse(msg.data);
        } catch {
          /* keep {} */
        }
        const key = type === 'gap' || seq === null ? `${type}-${lastSeq}-${gapN++}` : String(seq);
        pending.push({ key, seq, type, data } as JobEvent);
        if (!frame) frame = requestAnimationFrame(flush);

        if (type === 'result') {
          close();
          void qc.invalidateQueries({ queryKey: keys.job(jobId) });
          void qc.invalidateQueries({ queryKey: ['jobs'] });
          void qc.invalidateQueries({ queryKey: keys.summary });
          void qc.invalidateQueries({ queryKey: keys.repos });
        }
      });
    }
    es.onerror = () => {
      if (terminalRef.current) close();
    };

    return () => {
      es.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [jobId, enabled, qc]);

  return { events, live };
}
