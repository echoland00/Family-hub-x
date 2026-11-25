// Shared helpers for Family Hub X.
// Imported by App.jsx and CalendarView.jsx so both use the same source of truth
// (ECA lookup / kid colours / date formatting).

export const KID_COLORS = [
  { name: 'indigo',  bg: 'bg-indigo-100',  text: 'text-indigo-700',  border: 'border-indigo-200',  accent: 'bg-indigo-600' },
  { name: 'rose',    bg: 'bg-rose-100',    text: 'text-rose-700',    border: 'border-rose-200',    accent: 'bg-rose-500' },
  { name: 'emerald', bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200', accent: 'bg-emerald-500' },
  { name: 'amber',   bg: 'bg-amber-100',   text: 'text-amber-700',   border: 'border-amber-200',   accent: 'bg-amber-500' },
  { name: 'sky',     bg: 'bg-sky-100',     text: 'text-sky-700',     border: 'border-sky-200',     accent: 'bg-sky-500' },
];

// ECA (explicit-dates schema v2): return the ECAs whose `dates` include dateInput.
export const getECAsForDate = (kid, dateInput) => {
  const list = kid?.eca_recurring || [];
  if (!list.length) return [];
  const todayStr = typeof dateInput === 'string'
    ? dateInput.slice(0, 10)
    : (dateInput instanceof Date ? dateInput.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
  const matched = list.filter(eca => {
    if (!eca?.name) return false;
    const dates = eca.dates || [];
    return dates.map(d => String(d).slice(0, 10)).includes(todayStr);
  });
  // Sort by start_time ascending; ECAs without start_time go to the end (preserve relative order)
  const withTime = matched.filter(e => e.start_time);
  const withoutTime = matched.filter(e => !e.start_time);
  withTime.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  return [...withTime, ...withoutTime];
};

// Join ECA list into one display string, e.g. "Piano 16:00–17:00; Swimming"
export const formatECAList = (ecas) => {
  if (!ecas || !ecas.length) return '';
  return ecas.map(e => {
    const time = e.start_time ? `${e.start_time}${e.end_time ? '–' + e.end_time : ''}` : '';
    return time ? `${e.name} ${time}` : e.name;
  }).join('; ');
};

// Format a Date as YYYY-MM-DD using LOCAL components (NOT toISOString which is UTC).
export const ymdLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
