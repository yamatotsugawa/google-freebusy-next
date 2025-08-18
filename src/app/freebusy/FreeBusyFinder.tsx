'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';

const TZ = 'Asia/Tokyo';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

type TokenClient = {
  requestAccessToken: (opts?: { prompt?: 'consent' | 'none' }) => void;
};

type Gis = {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (resp: { access_token?: string; error?: string }) => void;
      }) => TokenClient;
    };
  };
};

declare global {
  interface Window {
    google?: Gis;
  }
}

/** LuxonのIntervalは使わず、null を含まない自前のスロット型で統一 */
type Slot = { start: DateTime; end: DateTime };

/** HH:mm → [hour, minute] */
function parseHHmm(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return [isNaN(h) ? 0 : h, isNaN(m) ? 0 : m];
}

export default function FreeBusyFinder() {
  const [gisLoaded, setGisLoaded] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const tokenClientRef = useRef<TokenClient | null>(null);
  const initDoneRef = useRef(false); // Token client 初期化の一度きりガード

  const today = useMemo(() => DateTime.now().setZone(TZ).startOf('day'), []);
  const [dateFrom, setDateFrom] = useState(today.plus({ days: 1 }).toISODate() || '');
  const [dateTo, setDateTo] = useState(today.plus({ days: 7 }).toISODate() || '');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('21:00');
  const [minSlotMins, setMinSlotMins] = useState<number>(0);

  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // --- Google Identity Services スクリプト読込み ---
  useEffect(() => {
    const id = 'gis-script';
    if (document.getElementById(id)) {
      setGisLoaded(true);
      return;
    }
    const s = document.createElement('script');
    s.id = id;
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => setGisLoaded(true);
    s.onerror = () => setError('Google Identity Services の読み込みに失敗しました。');
    document.head.appendChild(s);
  }, []);

  // --- Token client 初期化（依存配列は固定長に） ---
  useEffect(() => {
    if (initDoneRef.current) return;
    if (!gisLoaded || !CLIENT_ID || tokenClientRef.current) return;

    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) return;

    tokenClientRef.current = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          setError(`トークン取得に失敗: ${resp.error}`);
          return;
        }
        setAccessToken(resp.access_token ?? null);
      },
    });

    initDoneRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gisLoaded]); // ← 必ず1つに固定（Fast Refresh で配列長が変わらないように）
  // ------------------------------------------------

  const signIn = () => {
    setError(null);
    if (!tokenClientRef.current) {
      setError('OAuthクライアントの初期化が未完了です。CLIENT_IDやJS Originを確認してください。');
      return;
    }
    tokenClientRef.current.requestAccessToken({ prompt: 'consent' });
  };

  /** 期間（含む）の日付配列 */
  function buildDateRange(fromISO: string, toISO: string): DateTime[] {
    const start = DateTime.fromISO(fromISO, { zone: TZ }).startOf('day');
    const end = DateTime.fromISO(toISO, { zone: TZ }).startOf('day');
    const days: DateTime[] = [];
    for (let d = start; d <= end; d = d.plus({ days: 1 })) days.push(d);
    return days;
  }

  /** 1日分の空きスロットを算出（返値は start/end を必ず持つ Slot[]） */
  function calcFreeWindowsForDay(
    day: DateTime,
    dayStartHHmm: string,
    dayEndHHmm: string,
    busy: Slot[],
    minMins = 0
  ): Slot[] {
    const [sh, sm] = parseHHmm(dayStartHHmm);
    const [eh, em] = parseHHmm(dayEndHHmm);

    const dayStart = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
    const dayEnd = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
    if (dayEnd.toMillis() <= dayStart.toMillis()) return [];

    // 当日稼働時間にかかる busy のみ抽出 → 開始でソート
    const overlaps = busy
      .map(({ start, end }) => {
        const s = start <= end ? start : end;
        const e = end >= start ? end : start;
        return { start: s, end: e };
      })
      .filter(({ start, end }) => end.toMillis() > dayStart.toMillis() && start.toMillis() < dayEnd.toMillis())
      .sort((a, b) => a.start.toMillis() - b.start.toMillis());

    const free: Slot[] = [];
    let cursor = dayStart;

    for (const { start, end } of overlaps) {
      const bs = start < dayStart ? dayStart : start;
      const be = end > dayEnd ? dayEnd : end;

      if (bs.toMillis() > cursor.toMillis()) {
        const dur = bs.diff(cursor, 'minutes').minutes;
        if (dur >= minMins) free.push({ start: cursor, end: bs });
      }
      if (be.toMillis() > cursor.toMillis()) cursor = be;
    }

    if (cursor.toMillis() < dayEnd.toMillis()) {
      const dur = dayEnd.diff(cursor, 'minutes').minutes;
      if (dur >= minMins) free.push({ start: cursor, end: dayEnd });
    }

    return free;
  }

  /** Google FreeBusy API → busy を Slot[] に整形 */
  async function fetchBusy(fromISO: string, toISO: string): Promise<Slot[]> {
    if (!accessToken) throw new Error('Googleにログインしてください。');

    const body = {
      timeMin: DateTime.fromISO(fromISO, { zone: TZ }).startOf('day').toUTC().toISO(),
      timeMax: DateTime.fromISO(toISO, { zone: TZ }).endOf('day').toUTC().toISO(),
      timeZone: TZ,
      items: [{ id: 'primary' }],
    };

    const res = await fetch(FREEBUSY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`freeBusy取得エラー: ${res.status} ${t}`);
    }

    const data: {
      calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } };
    } = await res.json();

    const busy = data.calendars?.primary?.busy ?? [];
    return busy.map(({ start, end }) => ({
      start: DateTime.fromISO(start, { zone: TZ }),
      end: DateTime.fromISO(end, { zone: TZ }),
    }));
  }

  // 実行：日毎に「1行目=日付」「2行目=時刻」を出力
  const onRun = async () => {
    try {
      setError(null);
      setRunning(true);
      setLines([]);

      const busy = await fetchBusy(dateFrom, dateTo);
      const days = buildDateRange(dateFrom, dateTo);

      const outputs: string[] = [];
      for (const day of days) {
        const wins = calcFreeWindowsForDay(day, startTime, endTime, busy, minSlotMins);
        if (wins.length === 0) continue;

        const dateLabel = day.toFormat('M月d日');
        const ranges = wins.map(({ start, end }) => `${start.toFormat('H:mm')}〜${end.toFormat('H:mm')}`);

        outputs.push(dateLabel);
        outputs.push(ranges.join('  '));
      }
      setLines(outputs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const copyAll = async () => {
    await navigator.clipboard.writeText(lines.join('\n'));
    alert('コピーしました');
  };

  const box: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 };

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>空き時間抽出（Googleカレンダー）</h1>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
        <button
          onClick={signIn}
          disabled={!gisLoaded || !!accessToken || !CLIENT_ID}
          style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid #d1d5db', cursor: 'pointer' }}
          title={!gisLoaded ? '読み込み中' : accessToken ? '接続済み' : 'Googleに接続'}
        >
          {accessToken ? '接続済み' : 'Googleに接続'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>TZ: {TZ}（環境変数: {CLIENT_ID ? 'OK' : '未設定'}）</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={box}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label>
              <div style={{ fontSize: 12, color: '#6b7280' }}>開始日</div>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label>
              <div style={{ fontSize: 12, color: '#6b7280' }}>終了日</div>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
          </div>

          <div style={{ height: 12 }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label>
              <div style={{ fontSize: 12, color: '#6b7280' }}>1日の開始時刻</div>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label>
              <div style={{ fontSize: 12, color: '#6b7280' }}>1日の終了時刻</div>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </div>

          <div style={{ height: 12 }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'end' }}>
            <label>
              <div style={{ fontSize: 12, color: '#6b7280' }}>最小スロット（分, 任意）</div>
              <input
                type="number"
                min={0}
                step={5}
                value={minSlotMins}
                onChange={(e) => setMinSlotMins(Number(e.target.value))}
              />
            </label>
            <button
              onClick={onRun}
              disabled={!accessToken || running}
              style={{
                height: 36,
                padding: '0 16px',
                borderRadius: 10,
                border: 'none',
                background: '#111827',
                color: '#fff',
                cursor: 'pointer',
                opacity: !accessToken || running ? 0.6 : 1,
              }}
            >
              {running ? '計算中…' : '空き時間を抽出'}
            </button>
          </div>

          {error && <p style={{ marginTop: 8, color: '#dc2626', fontSize: 12 }}>{error}</p>}
        </div>

        <div style={box}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>抽出結果</strong>
            <button
              onClick={copyAll}
              disabled={lines.length === 0}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d1d5db', cursor: 'pointer' }}
            >
              まとめてコピー
            </button>
          </div>

          <div style={{ maxHeight: 380, overflow: 'auto', background: '#f9fafb', padding: 12, borderRadius: 8 }}>
            {lines.length === 0 ? (
              <p style={{ fontSize: 12, color: '#6b7280' }}>
                まだ結果はありません。条件を入力して「空き時間を抽出」を押してください。
              </p>
            ) : (
              <ul style={{ paddingLeft: 16 }}>
                {lines.map((l, i) => {
                  const isDateLine = i % 2 === 0;
                  return (
                    <li
                      key={i}
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 13,
                        marginBottom: isDateLine ? 2 : 10,
                        fontWeight: isDateLine ? 700 : 400,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {l}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
