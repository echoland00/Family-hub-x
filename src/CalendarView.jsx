import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, GraduationCap, Backpack, Bell } from 'lucide-react';
import { KID_COLORS, getECAsForDate, formatECAList, ymdLocal } from './fhxShared';

const WEEK_HEADER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS = 3; // chips shown per day cell before "+N"

const KIND_ICON = {
  eca: CalendarDays,
  test: GraduationCap,
  to_bring: Backpack,
  reminder: Bell,
};

// Month cell summary: first 5 chars of the first non-empty line.
export const chipText = (t) => {
  const first = (t || '').split('\n').find(l => l.trim()) || '';
  const s = first.trim();
  return s.length > 5 ? s.slice(0, 5).trim() + '…' : s;
};

/**
 * Calendar tab — read-only month grid.
 *
 * Data sources (all already written by the Schedule tab):
 *   - General Note  → hubs/{hubKey}/meals/{YYYY-MM-DD}_general .text   → grey dot (content NOT copied)
 *   - ECA / Test / To-bring / Reminder → per kid, coloured chips in that kid's colour
 *       · manual text → kids/{kidId}/daily-notes/{date}.{eca,test,to_bring,reminder}
 *       · 🔒 auto     → kids/{kidId}/reminders/{date}  + kid.eca_recurring[].dates
 *
 * Tapping a chip → onJump(date, kidId) → Schedule tab on that date, scrolled to that kid.
 */
export default function CalendarView({
  calMonth, setCalMonth, kids, calNotes, bulkReminders, meals, todayStr, onJump,
}) {
  const { cells, monthLabel } = useMemo(() => {
    const first = new Date(calMonth.y, calMonth.m, 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay()); // back to Sunday
    const list = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      list.push(d);
    }
    const label = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return { cells: list, monthLabel: label };
  }, [calMonth]);

  // Build the event list for every date that has something.
  const eventsByDate = useMemo(() => {
    const map = {};

    // General Note (hub level) — show a grey dot only, never the content.
    (meals || []).forEach(m => {
      if (!m?.id || !m.id.endsWith('_general')) return;
      const text = (m.text || '').trim();
      if (!text) return;
      const dateStr = (m.date || m.id.replace(/_general$/, '')).slice(0, 10);
      (map[dateStr] = map[dateStr] || []).push({ kind: 'general', text, chip: '' });
    });

    kids.forEach(kid => {
      const color = KID_COLORS.find(c => c.name === kid.color) || KID_COLORS[0];
      const notes = calNotes[kid.id] || {};
      const rems = bulkReminders[kid.id] || {};

      // Dates that could carry an event for this kid:
      // daily-notes docs + locked reminders + ECA dates from the kid profile.
      const dates = new Set([...Object.keys(notes), ...Object.keys(rems)]);
      (kid.eca_recurring || []).forEach(eca => {
        (eca.dates || []).forEach(d => dates.add(String(d).slice(0, 10)));
      });

      dates.forEach(dateStr => {
        const note = notes[dateStr] || {};
        const autoEca = formatECAList(getECAsForDate(kid, dateStr));
        const manualEca = (note.eca || '').trim();
        const ecaText = autoEca && manualEca ? `${autoEca}\n${manualEca}` : (autoEca || manualEca);

        const autoRem = (rems[dateStr] || '').trim();
        const manualRem = (note.reminder || '').trim();
        const remText = autoRem && manualRem ? `${autoRem}\n${manualRem}` : (autoRem || manualRem);

        const push = (kind, text, locked) => {
          if (!text) return;
          (map[dateStr] = map[dateStr] || []).push({
            id: `${kid.id}:${kind}:${dateStr}`,
            kind, text, chip: chipText(text),
            kidId: kid.id, kidName: kid.name, color, locked: !!locked,
          });
        };
        push('eca', ecaText, false);
        push('test', (note.test || '').trim(), false);
        push('to_bring', (note.to_bring || '').trim(), false);
        push('reminder', remText, !!autoRem);
      });
    });

    return map;
  }, [kids, calNotes, bulkReminders, meals]);

  const shiftMonth = (delta) => {
    setCalMonth(prev => {
      const d = new Date(prev.y, prev.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const goToday = () => {
    const d = new Date();
    setCalMonth({ y: d.getFullYear(), m: d.getMonth() });
  };

  return (
    <div className="space-y-3">
      {/* Month header */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex items-center gap-2 px-3 py-2.5">
        <button onClick={() => shiftMonth(-1)} className="p-2 bg-slate-50 rounded-xl shadow-sm active:scale-95">
          <ChevronLeft size={16} className="text-slate-600" />
        </button>
        <p className="font-bold text-sm text-slate-800 flex-1 text-center">{monthLabel}</p>
        <button onClick={() => shiftMonth(1)} className="p-2 bg-slate-50 rounded-xl shadow-sm active:scale-95">
          <ChevronRight size={16} className="text-slate-600" />
        </button>
        <button onClick={goToday} className="px-3 py-2 bg-slate-900 text-white rounded-xl text-[10px] font-bold uppercase tracking-widest active:scale-95">
          Today
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-400" /> General Note
        </span>
        {kids.filter(k => k.name).map(kid => {
          const c = KID_COLORS.find(x => x.name === kid.color) || KID_COLORS[0];
          return (
            <span key={kid.id} className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
              <span className={`w-2.5 h-2.5 rounded-full ${c.accent}`} /> {kid.name}
            </span>
          );
        })}
      </div>

      {/* Grid */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
          {WEEK_HEADER.map(d => (
            <div key={d} className={`py-2 text-center text-[10px] font-bold uppercase tracking-wider ${d === 'Sun' ? 'text-red-400' : 'text-slate-400'}`}>
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map(d => {
            const dateStr = ymdLocal(d);
            const inMonth = d.getMonth() === calMonth.m;
            const isToday = dateStr === todayStr;
            const isSun = d.getDay() === 0;
            const events = eventsByDate[dateStr] || [];
            const general = events.find(e => e.kind === 'general');
            const chips = events.filter(e => e.kind !== 'general');
            const shown = chips.slice(0, MAX_CHIPS);
            const extra = chips.length - shown.length;

            return (
              <div key={dateStr} className="min-h-[68px] border-r border-b border-slate-100 p-1 flex flex-col gap-0.5 last:border-r-0">
                <div className="flex items-center justify-between gap-1">
                  <button
                    onClick={() => onJump(dateStr, null)}
                    className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center ${
                      isToday ? 'bg-indigo-600 text-white'
                        : inMonth ? (isSun ? 'text-red-500' : 'text-slate-600')
                        : 'text-slate-300'}`}
                  >
                    {d.getDate()}
                  </button>
                  {general && (
                    <button
                      onClick={() => onJump(dateStr, null)}
                      title="General Note"
                      className="w-2.5 h-2.5 rounded-full bg-slate-400 flex-shrink-0"
                    />
                  )}
                </div>
                {shown.map(ev => {
                  const Icon = KIND_ICON[ev.kind] || CalendarDays;
                  return (
                    <button
                      key={ev.id}
                      onClick={() => onJump(dateStr, ev.kidId)}
                      title={`${ev.kidName || 'Kid'} · ${ev.kind === 'to_bring' ? 'To-bring' : ev.kind[0].toUpperCase() + ev.kind.slice(1)}${ev.locked ? ' (auto)' : ''}\n${ev.text}`}
                      className={`w-full ${ev.color.bg} border ${ev.color.border} rounded px-0.5 py-0.5 flex items-center gap-0.5 active:scale-95 transition-transform`}
                    >
                      <Icon size={8} className={`${ev.color.text} flex-shrink-0 hidden sm:block`} />
                      <span className={`text-[9px] font-bold ${ev.color.text} truncate min-w-0`}>{ev.chip}</span>
                    </button>
                  );
                })}
                {extra > 0 && (
                  <button onClick={() => onJump(dateStr, shown[0]?.kidId || null)} className="text-[8px] font-bold text-slate-400 px-1 text-left">
                    +{extra}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[10px] text-slate-400 text-center leading-relaxed px-4">
        Tap any pill to jump to that day in Schedule.
      </p>
    </div>
  );
}
