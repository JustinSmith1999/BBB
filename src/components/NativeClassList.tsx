// 2026-06-26 v3: Native BBB-branded class list. Day-picker layout.
// =====================================================================
// Top: 7-day pill row. Pick a day → only that day's classes show below.
// Each class row has room to breathe: instructor avatar, big tabular
// time, class name, spots chip, hover-revealed reserve arrow. On a busy
// day we sub-group by Morning / Afternoon / Evening.

import { useEffect, useMemo, useState } from 'react';
import { Calendar, Loader2, AlertCircle, ArrowRight, Sunrise, Sunset } from 'lucide-react';
import { fetchClassesForLocation, type MTClassSession } from '../lib/mtClient';
import MTBookingModal from './MTBookingModal';

interface Props {
  mtLocationId: number;
  studioName: string;
  studioSlug: string;
  /** How many days forward to show. Default 7. */
  days?: number;
  /** Optional CTA when there's no payment-flow yet — eg. trial signup. */
  trialHref?: string;
}

// ─── Time helpers ─────────────────────────────────────────────────────────
const TZ = 'America/New_York';

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: TZ,
  });
}
function getHourET(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: TZ,
  }).formatToParts(new Date(iso));
  return Number(parts.find(p => p.type === 'hour')?.value ?? '0');
}
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}
function todayKeyET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}
function tomorrowKeyET(): string {
  const t = new Date(); t.setDate(t.getDate() + 1);
  return t.toLocaleDateString('en-CA', { timeZone: TZ });
}
function fmtFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: TZ,
  });
}

type TimeOfDay = 'morning' | 'evening';
function timeOfDay(iso: string): TimeOfDay {
  // Single split at noon — keeps the page calm. Morning = AM, Evening = PM.
  return getHourET(iso) < 12 ? 'morning' : 'evening';
}
const TOD_META: Record<TimeOfDay, { label: string; Icon: typeof Sunrise }> = {
  morning: { label: 'Morning', Icon: Sunrise },
  evening: { label: 'Evening', Icon: Sunset },
};

// (instructor avatars removed — BBB brand is black/red/white only)

// ─── Main ─────────────────────────────────────────────────────────────────
export default function NativeClassList({ mtLocationId, studioName, days = 7, trialHref }: Props) {
  const [sessions, setSessions] = useState<MTClassSession[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error,   setError]     = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [bookingSession, setBookingSession] = useState<MTClassSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      const res = await fetchClassesForLocation(mtLocationId, { days });
      if (cancelled) return;
      if (!res.ok) { setError(res.error); setSessions([]); setLoading(false); return; }
      setSessions(res.sessions);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [mtLocationId, days]);

  // Build day list (always show next N days even if no classes for that day)
  const dayList = useMemo(() => {
    const todayKey = todayKeyET();
    // Hide classes that have already started — MT lets people reserve up
    // until class start, so a 5-min grace keeps the just-started class
    // visible briefly without listing classes from 4 hours ago.
    const nowMs = Date.now() - 5 * 60_000;
    // Index sessions by day, filtering out anything already past
    const byDay: Record<string, MTClassSession[]> = {};
    for (const s of sessions) {
      if (new Date(s.start_datetime).getTime() < nowMs) continue;
      const k = dayKey(s.start_datetime);
      (byDay[k] ||= []).push(s);
    }
    // Build forward N-day window from today
    const list: { dayKey: string; iso: string; classes: MTClassSession[] }[] = [];
    const start = new Date(todayKey + 'T12:00:00Z'); // mid-day to avoid TZ edge
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
      const k = d.toLocaleDateString('en-CA', { timeZone: TZ });
      list.push({ dayKey: k, iso: d.toISOString(), classes: byDay[k] || [] });
    }
    return list;
  }, [sessions, days]);

  // Default to today (or first day that has classes if today is empty)
  useEffect(() => {
    if (activeDay || dayList.length === 0) return;
    const todayKey = todayKeyET();
    const today = dayList.find(d => d.dayKey === todayKey);
    if (today && today.classes.length > 0) { setActiveDay(today.dayKey); return; }
    const firstWithClasses = dayList.find(d => d.classes.length > 0);
    setActiveDay(firstWithClasses ? firstWithClasses.dayKey : dayList[0].dayKey);
  }, [dayList, activeDay]);

  // ─── States ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center" aria-live="polite">
        <Loader2 className="w-7 h-7 text-red-600 animate-spin mb-3" />
        <p className="text-sm text-gray-500 font-semibold tracking-wide">Loading classes…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center border border-red-200 bg-red-50/60 rounded-2xl">
        <AlertCircle className="w-7 h-7 text-red-600 mb-2" />
        <p className="text-sm font-bold text-red-700 mb-1">Couldn't load classes</p>
        <p className="text-xs text-red-600/80 max-w-md leading-relaxed mb-4">{error}</p>
        {trialHref && (
          <a href={trialHref} className="text-sm font-bold text-red-700 hover:text-red-800 underline">
            Start your 2-week trial instead →
          </a>
        )}
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center border border-gray-200 rounded-2xl bg-gray-50/60">
        <Calendar className="w-8 h-8 text-gray-400 mb-3" />
        <p className="text-base font-bold text-gray-800 mb-1">No classes scheduled in the next week</p>
        <p className="text-sm text-gray-500 max-w-md">Check back soon or contact the studio directly.</p>
      </div>
    );
  }

  const todayKey    = todayKeyET();
  const tomorrowKey = tomorrowKeyET();
  const activeData  = dayList.find(d => d.dayKey === activeDay);
  const activeClasses = activeData?.classes ?? [];
  const showTodGroups = activeClasses.length >= 5;

  const byTod: Record<TimeOfDay, MTClassSession[]> = { morning: [], afternoon: [], evening: [] };
  for (const s of activeClasses) byTod[timeOfDay(s.start_datetime)].push(s);

  return (
    <div>
      {/* ───────── Day picker — full-width 7-column grid ──────────────── */}
      <div
        role="tablist"
        aria-label="Pick a day"
        className="grid grid-cols-7 gap-2 sm:gap-3"
      >
        {dayList.map(({ dayKey: k, iso, classes }) => {
          const d = new Date(iso);
          const wkday = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ }).toUpperCase();
          const dayNum = d.toLocaleDateString('en-US', { day: 'numeric', timeZone: TZ });
          const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: TZ });
          const isActive   = k === activeDay;
          const isToday    = k === todayKey;
          const isTomorrow = k === tomorrowKey;
          const empty      = classes.length === 0;
          const label      = isToday ? 'TODAY' : isTomorrow ? 'TOMORROW' : wkday;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveDay(k)}
              disabled={empty && !isActive}
              className={`relative py-4 sm:py-5 px-1 rounded-xl border-2 transition-all text-center select-none ${
                isActive
                  ? 'bg-black text-white border-black shadow-xl shadow-black/25'
                  : empty
                    ? 'bg-white border-gray-100 text-gray-300 cursor-not-allowed'
                    : 'bg-white border-gray-200 text-gray-800 hover:border-black hover:-translate-y-0.5 hover:shadow-md'
              }`}
            >
              {isActive && isToday && (
                <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" aria-hidden />
              )}
              <div className={`text-[9px] sm:text-[10px] font-black uppercase tracking-[0.15em] truncate px-1 ${
                isActive
                  ? (isToday ? 'text-red-400' : 'text-white/60')
                  : (isToday ? 'text-red-600' : 'text-gray-400')
              }`}>
                {label}
              </div>
              <div className={`text-2xl sm:text-4xl font-black tabular-nums leading-none mt-1.5 ${
                isActive ? 'text-white' : (empty ? 'text-gray-300' : 'text-black')
              }`}>
                {dayNum}
              </div>
              <div className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-wider mt-1 ${
                isActive ? 'text-white/60' : 'text-gray-400'
              }`}>
                {month}
              </div>
              <div className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-wider mt-2 sm:mt-3 ${
                isActive
                  ? 'text-white/80'
                  : (empty ? 'text-gray-300' : 'text-gray-500')
              }`}>
                {empty ? '—' : `${classes.length}`}
                {!empty && <span className="hidden sm:inline"> {classes.length === 1 ? 'class' : 'classes'}</span>}
              </div>
            </button>
          );
        })}
      </div>

      {/* ───────── Day heading ────────────────────────────────────────── */}
      {activeData && (
        <div className="mt-10 mb-6 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-black leading-[1.05]">
              {fmtFullDate(activeData.iso)}
            </h3>
            {activeClasses.length > 0 && (
              <p className="text-sm text-gray-500 mt-2 font-medium">
                {activeClasses.length} {activeClasses.length === 1 ? 'class' : 'classes'}
                {showTodGroups && (
                  <>
                    {' · '}{byTod.morning.length} morning
                    {byTod.afternoon.length > 0 && <> · {byTod.afternoon.length} afternoon</>}
                    {byTod.evening.length > 0   && <> · {byTod.evening.length} evening</>}
                  </>
                )}
              </p>
            )}
          </div>
          {activeData.dayKey === todayKey && activeClasses.length > 0 && (
            <span className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.15em] text-red-600">
              <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse" />
              Live today
            </span>
          )}
        </div>
      )}

      {/* ───────── Class list — full-width 2-col grid ─────────────────── */}
      <div>
        {activeClasses.length === 0 ? (
          <div className="py-16 px-6 text-center border border-dashed border-gray-300 rounded-2xl">
            <Calendar className="w-7 h-7 text-gray-400 mb-3 mx-auto" />
            <p className="text-sm font-bold text-gray-700 mb-1">No classes scheduled for this day</p>
            <p className="text-xs text-gray-500">Pick another day above.</p>
          </div>
        ) : showTodGroups ? (
          <div className="space-y-20">
            {(['morning', 'evening'] as TimeOfDay[]).map((tod) => {
              const list = byTod[tod];
              if (list.length === 0) return null;
              const { Icon, label } = TOD_META[tod];
              return (
                <div key={tod}>
                  <div className="flex items-center gap-3 mb-8">
                    <Icon className="w-5 h-5 text-gray-600" />
                    <span className="text-xs font-black uppercase tracking-[0.22em] text-gray-700">
                      {label}
                    </span>
                    <span className="text-xs font-bold text-gray-300 tabular-nums">
                      {list.length}
                    </span>
                    <div className="flex-1 h-px bg-gray-200 ml-1" />
                  </div>
                  <ul className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-10">
                    {list.map((s) => (
                      <NativeClassRow key={s.id} session={s} onBook={() => setBookingSession(s)} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <ul className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-10">
            {activeClasses.map((s) => (
              <NativeClassRow key={s.id} session={s} onBook={() => setBookingSession(s)} />
            ))}
          </ul>
        )}
      </div>

      {/* Booking modal — embeds the MT widget for in-browser reserve */}
      {bookingSession && (
        <MTBookingModal
          session={bookingSession}
          studioName={studioName}
          onClose={() => setBookingSession(null)}
        />
      )}
    </div>
  );
}

// ─── Single class row — BBB brand only (black / white / red / gray) ──────
function NativeClassRow({ session: s, onBook }: { session: MTClassSession; onBook: () => void }) {
  const isFull = s.is_full && !s.waitlist_open;
  const isWL   = s.waitlist_open;
  const isLow  = !isFull && !isWL && s.available_count > 0 && s.available_count <= 3;
  const hasCount = s.available_count > 0 || s.capacity > 0;
  const instructor = s.instructor_names[0] || null;

  let chip: { text: string; cls: string } | null = null;
  if (isFull)        chip = { text: 'Full',                       cls: 'bg-gray-100 text-gray-500' };
  else if (isWL)     chip = { text: 'Waitlist',                   cls: 'bg-black text-white' };
  else if (isLow)    chip = { text: `${s.available_count} left`,  cls: 'bg-red-600 text-white' };
  else if (hasCount) chip = { text: `${s.available_count} open`,  cls: 'bg-gray-100 text-gray-700' };

  const interactive = !isFull;

  return (
    <li className="group/row">
      <button
        type="button"
        onClick={interactive ? onBook : undefined}
        disabled={!interactive}
        className={`relative w-full flex items-center gap-5 sm:gap-7 py-7 sm:py-8 pl-7 sm:pl-9 pr-5 sm:pr-7 rounded-2xl border-2 transition-all overflow-hidden text-left ${
          interactive
            ? 'bg-white border-gray-200 hover:border-black hover:-translate-y-1 hover:shadow-xl cursor-pointer'
            : 'bg-gray-50 border-gray-100 opacity-60 cursor-not-allowed'
        }`}
      >
        {/* Left red accent bar — pure brand */}
        <span
          className={`absolute left-0 top-0 bottom-0 w-1.5 transition-all ${
            isFull ? 'bg-gray-200' : 'bg-red-600 group-hover/row:w-2'
          }`}
          aria-hidden
        />

        {/* Time block */}
        <div className="flex-none w-28 sm:w-32">
          <div className="text-2xl sm:text-3xl font-black text-black tabular-nums tracking-tight leading-none whitespace-nowrap">
            {fmtTime(s.start_datetime)}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400 mt-2.5 tabular-nums">
            {s.duration_min} MIN
          </div>
        </div>

        {/* Vertical divider */}
        <span className="hidden sm:block flex-none w-px h-14 bg-gray-200" aria-hidden />

        {/* Class details */}
        <div className="flex-1 min-w-0">
          {/* 2026-07-02 QA #16: was `truncate` — clipped names like "THIGHS
              THURSD…" even with vertical room to spare. Two-line clamp keeps
              the card tidy while showing the full class name. */}
          <div className="text-base sm:text-lg font-black text-black tracking-tight leading-tight line-clamp-2 break-words uppercase">
            {s.class_name}
          </div>
          {instructor && (
            <div className="text-xs sm:text-sm text-gray-500 mt-2 truncate">
              <span className="text-gray-400">w/</span> <span className="font-bold text-gray-800">{instructor}</span>
            </div>
          )}
        </div>

        {/* Status + arrow */}
        <div className="flex-none flex flex-col items-end gap-2.5">
          {chip && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider whitespace-nowrap ${chip.cls}`}
            >
              {chip.text}
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] whitespace-nowrap transition-all ${
              isFull
                ? 'text-gray-400'
                : 'text-black group-hover/row:text-red-600'
            }`}
          >
            {isFull ? 'Full' : isWL ? 'Waitlist' : 'Reserve'}
            {!isFull && (
              <ArrowRight className="w-3 h-3 transform transition-transform group-hover/row:translate-x-1" />
            )}
          </span>
        </div>
      </button>
    </li>
  );
}
