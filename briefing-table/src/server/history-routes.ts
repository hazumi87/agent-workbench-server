/* THE HISTORY EXPORT'S HTTP SURFACE [lead order 15713, step 7 engine half; local mode only]: what the Settings > Chat history page needs.
 *
 *   GET   /api/history-export          { enabled, running, done, total, written, lastRunAt, lastError, folder }
 *   PATCH /api/history-export          { enabled: boolean }  the "Save a copy of each finished day" toggle (default on)
 *   POST  /api/history-export/run      { now: true, roomId? } Export now: today so far -> { files: [{roomId, name, lines}] }
 *                                      {} (no `now`) starts the catch-up in the background -> 202 { started }, progress via GET
 *   POST  /api/history-export/cancel   stops the catch-up after the current day
 * Answers 404 outside local mode (no files folder, nothing to export to). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HistoryExporter, type LineRow } from '../engine/history-export.ts';
import { historyDirOnDisk, writeNew } from '../engine/local-file-store.ts';
import { readBody, sendJson } from './http-util.ts';

export interface HistoryTable {
  listRooms: () => Array<{ id: string; name: string }>;
  firstLineTs: (roomId: string) => number | null;
  exportLines: (roomId: string, fromTs: number, toTs: number) => LineRow[];
  roomAssetFolder: (roomId: string) => string;
  getEngineSetting: (key: string) => unknown;
  setEngineSetting: (key: string, value: unknown) => void;
}

export const MARKERS_KEY = 'historyExportMarkers';
export const ENABLED_KEY = 'historyExportEnabled';

export function createExporter(filesRoot: string, t: HistoryTable, onError: (m: string) => void): HistoryExporter {
  return new HistoryExporter({
    now: () => Date.now(),
    rooms: () => t.listRooms().map((r) => ({ id: r.id, name: r.name })),
    firstTs: (id) => t.firstLineTs(id),
    lines: (id, from, to) => t.exportLines(id, from, to),
    write: (roomId, name, content) => writeNew(filesRoot, historyDirOnDisk(filesRoot, t.roomAssetFolder(roomId)), name, content),
    getMarker: (id) => ((t.getEngineSetting(MARKERS_KEY) as Record<string, string> | null) ?? {})[id] ?? null,
    setMarker: (id, day) => t.setEngineSetting(MARKERS_KEY, { ...((t.getEngineSetting(MARKERS_KEY) as Record<string, string> | null) ?? {}), [id]: day }),
    enabled: () => t.getEngineSetting(ENABLED_KEY) !== false,
    yieldNow: () => new Promise((r) => setImmediate(r)),
    onError,
  });
}

/** Handles the four routes; false when the path is not one of them. */
export async function handleHistoryRoute(req: IncomingMessage, res: ServerResponse, pathname: string, x: HistoryExporter, t: HistoryTable, filesRoot: string): Promise<boolean> {
  if (pathname !== '/api/history-export' && !pathname.startsWith('/api/history-export/')) {
    return false;
  }
  const method = req.method ?? 'GET';
  const status = () => ({ ...x.status(), folder: filesRoot });
  if (pathname === '/api/history-export' && method === 'GET') {
    sendJson(res, 200, status());
    return true;
  }
  if (pathname === '/api/history-export' && method === 'PATCH') {
    const b = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    if (typeof b.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled is true or false', field: 'enabled' });
      return true;
    }
    t.setEngineSetting(ENABLED_KEY, b.enabled);
    sendJson(res, 200, status());
    return true;
  }
  if (pathname === '/api/history-export/run' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    if (b.now === true) {
      const roomId = typeof b.roomId === 'string' && b.roomId ? b.roomId : undefined;
      try {
        sendJson(res, 200, { files: x.exportNow(roomId) });
      } catch (e) {
        sendJson(res, 500, { error: `could not export: ${(e as Error).message}` });
      }
      return true;
    }
    if (!x.status().enabled) {
      sendJson(res, 409, { error: 'the export is switched off', field: 'enabled' });
      return true;
    }
    const was = x.status().running;
    if (!was) {
      void x.catchUp();
    }
    sendJson(res, 202, { started: !was, ...status() });
    return true;
  }
  if (pathname === '/api/history-export/cancel' && method === 'POST') {
    x.cancel();
    sendJson(res, 200, status());
    return true;
  }
  sendJson(res, 404, { error: 'no such history-export route' });
  return true;
}
