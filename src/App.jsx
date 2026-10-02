import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, sendPasswordResetEmail, updatePassword, updateProfile, signOut } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, onSnapshot, addDoc, updateDoc, deleteDoc, writeBatch, query, orderBy, where, arrayRemove, deleteField } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import * as XLSX from 'xlsx';

import {
  Utensils, ShoppingCart, Plus, CheckCircle2, Circle, Trash2, RefreshCw,
  ChevronLeft, ChevronRight, Sparkles, X, Home, Fingerprint, ShieldCheck,
  FileUp, PlusCircle, KeyRound, Zap, FolderPlus, ChevronRight as ChevronRightIcon, Lock, Users2, Copy, UserPlus,
  Tag, LayoutGrid, Info, StickyNote, Send, Download, BookOpen,
  Sun, Users, Baby, School, Shirt, Bus, CalendarDays, GraduationCap, Pencil,
  Backpack, Bell, PencilLine
} from 'lucide-react';

// Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyC0717TOX3YK_Zck6UNIoXFOGMNlhH_FsM",
  authDomain: "family-hub-v2-72195.firebaseapp.com",
  projectId: "family-hub-v2-72195",
  storageBucket: "family-hub-v2-72195.firebasestorage.app",
  messagingSenderId: "178135700731",
  appId: "1:178135700731:web:668ffed07c9e670d564c5e"
};

const APP_VERSION = "X 0.1.0";
const MEAL_TYPES = ['Breakfast', 'Lunch', 'Snack', 'Dinner'];

const KID_COLORS = [
  { name: 'indigo',  bg: 'bg-indigo-100',  text: 'text-indigo-700',  border: 'border-indigo-200',  accent: 'bg-indigo-600' },
  { name: 'rose',    bg: 'bg-rose-100',    text: 'text-rose-700',    border: 'border-rose-200',    accent: 'bg-rose-500' },
  { name: 'emerald', bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200', accent: 'bg-emerald-500' },
  { name: 'amber',   bg: 'bg-amber-100',   text: 'text-amber-700',   border: 'border-amber-200',   accent: 'bg-amber-500' },
  { name: 'sky',     bg: 'bg-sky-100',     text: 'text-sky-700',     border: 'border-sky-200',     accent: 'bg-sky-500' },
];

const KID_GRADES = ['K1','K2','K3','P1','P2','P3','P4','P5','P6','F1','F2','F3','F4','F5','F6'];

// Self-clear needs_password_setup after successful password login.
// User proved they have a password by signing in successfully.
async function clearPasswordSetupFlag(db, appId, hubKey, uid) {
  try {
    const memberRef = doc(db, 'artifacts', appId, 'public', 'data', 'hubs', hubKey, 'members', uid);
    const snap = await getDoc(memberRef);
    if (snap.exists() && snap.data().needs_password_setup) {
      await updateDoc(memberRef, {
        needs_password_setup: false,
        has_password: true,
        last_password_change_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn('clearPasswordSetupFlag failed (non-fatal):', e);
  }
}

const WEEKDAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
const WEEKDAY_LABELS = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
const SUN_HEADER_CLS = 'text-red-500';
const SUN_DAY_NUM_CLS = 'text-red-500';
const UNIFORM_OPTIONS = ['Uniform', 'Sportswear', 'Casual'];

// Translate Chinese dress-code labels to English (display-layer only)
const translateDressCode = (v) => {
  if (v == null || v === '') return '';
  const s = String(v);
  if (s === '校服') return 'Uniform';
  if (s === '體育服') return 'Sportswear';
  if (s === '便服' || s === '休閒') return 'Casual';
  return s;  // already English (Uniform / Sportswear / Casual) or unknown — pass through
};

const blankUniformSchedule = () => ({
  type: 'fixed',
  weekday_map: { mon: 'Uniform', tue: 'Uniform', wed: 'Sportswear', thu: 'Uniform', fri: 'Uniform' },
  rotation: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, uniform: 'Uniform', note: '' })),
  rotation_length: 7,
  start_date: new Date().toISOString().slice(0, 10),
});

const blankKid = {
  name: '', school: '', school_phone: '', grade: '', className: '', student_no: '', color: 'indigo', avatar: '',
  uniform_schedule: blankUniformSchedule(),
  school_holidays: [], // non-Sat/Sun school holidays (cycle skips these too)
  exam_dates: [],      // exam days — cycle skips these (tracked separately for clarity)
  special_dates: [],   // special activity days — cycle skips these (separate from exams)
  eca_recurring: [],   // [{ name, dates: ['YYYY-MM-DD', ...], start_time?, end_time? }] (v2 schema: explicit dates)
};

// Compute recurring ECAs that fall on a given date for a kid
// Returns array of ECA objects (with computed time window) that match.
const WEEKDAY_KEYS_FULL = ['sun','mon','tue','wed','thu','fri','sat'];
// Ping pong (table tennis) — 🏓 emoji
const ECAIcon = ({ size = 14, className = '' }) => (
  <span className={className} style={{ fontSize: size, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>🏓</span>
);
const getECAsForDate = (kid, dateInput) => {
  const list = kid?.eca_recurring || [];
  if (!list.length) return [];
  const todayStr = typeof dateInput === 'string'
    ? dateInput.slice(0, 10)
    : (dateInput instanceof Date ? dateInput.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
  // New schema (v2): explicit dates array — just lookup
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

const formatECAList = (ecas) => {
  if (!ecas || !ecas.length) return '';
  return ecas.map(e => {
    const time = e.start_time ? `${e.start_time}${e.end_time ? '–' + e.end_time : ''}` : '';
    return time ? `${e.name} ${time}` : e.name;
  }).join('; ');
};

// Combined skip-day set for cycle N-day counter (holidays + exams + special days)
const getSkipDates = (kid) => [
  ...(kid?.school_holidays || []),
  ...(kid?.exam_dates || []),
  ...(kid?.special_dates || []),
];

// Helper: format a Date as YYYY-MM-DD using LOCAL components (NOT toISOString which is UTC).
const ymdLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Count school days (Mon-Fri, excluding skipDates) between startDate and endDate inclusive
const countSchoolDays = (startDate, endDate, skipDates = []) => {
  const skipSet = new Set(skipDates);
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const wd = (d.getDay() + 6) % 7; // 0 = Mon, 5 = Sat, 6 = Sun
    if (wd < 5 && !skipSet.has(ymdLocal(d))) {
      count++;
    }
  }
  return count;
};

// ─── Date picker section (used for school holidays / exam dates / special dates) ──────────
// Self-contained: manages its own open/view/draft/range state. field specifies which kidForm key.
const DatePickerSection = ({ field, title, hint, IconComp, kidForm, setKidForm, showToast, palette = 'indigo' }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ y: new Date().getFullYear(), m: new Date().getMonth() });
  const [draft, setDraft] = useState(new Set());
  const [range, setRange] = useState({ from: '', to: '' });
  const dates = kidForm[field] || [];
  const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  function shiftMonth(delta) {
    setView(prev => {
      let { y, m } = prev;
      m += delta;
      if (m < 0) { m += 12; y -= 1; }
      if (m > 11) { m -= 12; y += 1; }
      return { y, m };
    });
  }
  function addRange() {
    if (!range.from || !range.to) { showToast('Pick range dates first', 'warn'); return; }
    if (range.from > range.to) { showToast('From must be before To', 'warn'); return; }
    const [fy, fm, fd] = range.from.split('-').map(Number);
    const [ey, em, ed] = range.to.split('-').map(Number);
    const added = [];
    for (let d = new Date(fy, fm - 1, fd); d <= new Date(ey, em - 1, ed); d.setDate(d.getDate() + 1)) {
      added.push(ymd(d.getFullYear(), d.getMonth(), d.getDate()));
    }
    if (!added.length) return;
    const merged = Array.from(new Set([...(dates), ...added])).sort();
    setKidForm(prev => ({ ...prev, [field]: merged }));
    showToast(`Added ${added.length} date(s)`, 'success');
    setRange({ from: '', to: '' });
  }
  function applyDraft() {
    if (!draft.size) { setOpen(false); setDraft(new Set()); return; }
    const added = Array.from(draft);
    const merged = Array.from(new Set([...(dates), ...added])).sort();
    setKidForm(prev => ({ ...prev, [field]: merged }));
    showToast(`Added ${added.length} date(s)`, 'success');
    setOpen(false);
    setDraft(new Set());
  }
  function openCalendar() {
    const seed = dates[0] || new Date().toISOString().slice(0, 10);
    const d = new Date(seed + 'T00:00:00');
    setOpen(true);
    setView({ y: d.getFullYear(), m: d.getMonth() });
    setDraft(new Set());
    setRange({ from: '', to: '' });
  }
  // Build calendar cells for current view
  const firstOfMonth = new Date(view.y, view.m, 1);
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const firstDow = firstOfMonth.getDay(); // 0 = Sun (leftmost)
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let dom = 1; dom <= daysInMonth; dom++) {
    const d = new Date(view.y, view.m, dom);
    const dowKey = WEEKDAY_KEYS_FULL[d.getDay()];
    cells.push({ ds: ymd(view.y, view.m, dom), dom, d, dowKey });
  }
  const monthLabel = new Date(view.y, view.m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return (
    <div className="pt-2 border-t border-slate-100">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
          <IconComp size={12} /> {title}
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => {
            // Save: close the calendar (any in-progress picks via bulk range add are already in state)
            setOpen(false);
            setDraft(new Set());
            showToast(`Saved ${dates.length} date(s) to draft`, 'success');
          }} className="text-[9px] font-bold text-indigo-500 uppercase tracking-widest hover:text-indigo-700">Save</button>
          {dates.length > 0 && (
            <button type="button" onClick={() => {
              if (window.confirm(`Clear all ${dates.length} dates from "${title}"?`)) {
                setKidForm(prev => ({ ...prev, [field]: [] }));
                showToast('Cleared all dates', 'success');
              }
            }} className="text-[9px] font-bold text-red-400 uppercase tracking-widest hover:text-red-600">Clear all</button>
          )}
        </div>
      </div>
      {hint && <p className="text-[10px] text-slate-400 mb-2">{hint}</p>}

      <button type="button" onClick={() => open ? setOpen(false) : openCalendar()}
        className={`w-full px-3 py-2 rounded-xl text-xs font-bold uppercase ${open ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-600 border border-indigo-100'}`}>
        {open ? 'Close calendar' : 'Multi-add dates'}
      </button>

      {open && (
        <div className="mt-2 bg-white rounded-xl p-3 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => shiftMonth(-1)} className="p-1 bg-slate-100 rounded-lg"><ChevronLeft size={14} /></button>
            <span className="text-xs font-bold text-slate-700">{monthLabel}</span>
            <button type="button" onClick={() => shiftMonth(1)} className="p-1 bg-slate-100 rounded-lg"><ChevronRight size={14} /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center mb-1">
            {WEEKDAY_KEYS_FULL.map(k => (
              <div key={k} className={`text-[9px] font-bold uppercase ${k === 'sun' ? SUN_HEADER_CLS : 'text-slate-400'}`}>{WEEKDAY_LABELS[k]}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((c, i) => {
              if (!c) return <div key={'b' + i} />;
              const already = dates.includes(c.ds);
              const inDraft = draft.has(c.ds);
              const isSun = c.dowKey === 'sun';
              const cls = already
                ? 'bg-amber-100 text-amber-400 line-through'
                : inDraft
                  ? 'bg-indigo-600 text-white'
                  : isSun
                    ? 'bg-slate-50 text-red-500 hover:bg-slate-200'
                    : 'bg-slate-50 text-slate-700 hover:bg-slate-200';
              return (
                <button
                  key={c.ds}
                  type="button"
                  onClick={() => {
                    if (already) return;
                    setDraft(prev => {
                      const next = new Set(prev);
                      if (next.has(c.ds)) next.delete(c.ds); else next.add(c.ds);
                      return next;
                    });
                  }}
                  className={`h-8 rounded text-[11px] font-bold ${cls}`}
                  title={c.ds}
                >
                  {c.dom}
                </button>
              );
            })}
          </div>

          <div className="mt-3 pt-2 border-t border-slate-100">
            <div className="text-[9px] font-bold text-slate-400 uppercase mb-1">Bulk range — add all days in range</div>
            <div className="flex items-center gap-1">
              <input type="date" value={range.from} onChange={(e) => setRange(prev => ({ ...prev, from: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
              <span className="text-[10px] text-slate-400">to</span>
              <input type="date" value={range.to} onChange={(e) => setRange(prev => ({ ...prev, to: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
              <button type="button" onClick={addRange} className="bg-slate-200 text-slate-700 px-3 py-1 rounded text-[10px] font-bold uppercase whitespace-nowrap">Add</button>
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-100">
            <span className="text-[10px] font-bold text-slate-400 uppercase">
              {draft.size} selected
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={() => { setOpen(false); setDraft(new Set()); }} className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg text-[10px] font-bold uppercase">Cancel</button>
              <button type="button" onClick={applyDraft} disabled={!draft.size} className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase ${draft.size ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-400'}`}>
                Add {draft.size} date(s)
              </button>
            </div>
          </div>
        </div>
      )}

      {dates.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {dates.slice(0, 16).map(d => (
            <span key={d} className="bg-slate-50 px-2 py-0.5 rounded-md text-[10px] font-bold text-slate-600 flex items-center gap-1 border border-slate-100">
              {d}
              <button type="button" onClick={() => setKidForm(prev => ({ ...prev, [field]: prev[field].filter(x => x !== d) }))} className="text-slate-300 hover:text-red-500">
                <X size={10} />
              </button>
            </span>
          ))}
          {dates.length > 16 && (
            <span className="text-[10px] font-bold text-slate-400 px-2 py-0.5">+{dates.length - 16} more</span>
          )}
        </div>
      )}
    </div>
  );
};

// Compute today's uniform for a kid given a date string (YYYY-MM-DD or Date)
const computeUniformForDate = (kid, dateInput) => {
  const us = kid?.uniform_schedule;
  if (!us) return null;
  const todayStr = dateInput instanceof Date
    ? dateInput.toISOString().slice(0, 10)
    : (typeof dateInput === 'string' ? dateInput.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const today = new Date(todayStr + 'T00:00:00');
  const dayIdx = (today.getDay() + 6) % 7; // 0 = Mon, 5 = Sat, 6 = Sun
  const isWeekend = dayIdx >= 5;
  const skipDates = getSkipDates(kid);
  const isSkipDay = skipDates.includes(todayStr);

  // Fixed: lookup by weekday
  if (us.type === 'fixed') {
    if (isWeekend || isSkipDay) return null; // no uniform on off-days
    return translateDressCode(us.weekday_map?.[WEEKDAY_KEYS[dayIdx]]) || 'Uniform';
  }

  // Cycle: start_date = Day 1; cycle advances only on school days
  if (us.type === 'cycle' && us.start_date) {
    if (isWeekend || isSkipDay) return null; // skip — no uniform on off-days
    const cycleLen = us.rotation_length || (us.rotation?.length) || 7;
    const startStr = us.start_date.slice(0, 10);
    const start = new Date(startStr + 'T00:00:00');
    today.setHours(0, 0, 0, 0);
    if (today < start) return null; // cycle hasn't started yet
    const schoolDays = countSchoolDays(start, today, skipDates);
    const idx = ((schoolDays - 1) % cycleLen + cycleLen) % cycleLen;
    const entry = us.rotation?.[idx];
    if (!entry) return 'Uniform';
    const uni = translateDressCode(entry.uniform) || 'Uniform';
    return entry.note ? `${uni} · ${entry.note}` : uni;
  }

  return null;
};

const SUGGESTED_MEALS = {
  Breakfast: ['Avocado Toast', 'Pancakes', 'Scrambled Eggs'],
  Lunch: ['Chicken Caesar Salad', 'Tomato Soup', 'Turkey Club'],
  Snack: ['Fruit Bowl', 'Yogurt', 'Nuts', 'Hummus & Carrots'],
  Dinner: ['Spaghetti Carbonara', 'Grilled Salmon', 'Thai Green Curry']
};

const BIBLE_VERSES = [
  { text: "The Lord is my shepherd; I shall not want.", source: "Psalm 23:1" },
  { text: "I can do all things through Christ who strengthens me.", source: "Philippians 4:13" },
  { text: "Trust in the Lord with all your heart.", source: "Proverbs 3:5" },
  { text: "Be strong and courageous. Do not be afraid.", source: "Joshua 1:9" },
  { text: "The Lord bless you and keep you.", source: "Numbers 6:24" },
  { text: "God is love.", source: "1 John 4:8" },
  { text: "Fear not, for I am with you.", source: "Isaiah 43:5" },
  { text: "The truth will set you free.", source: "John 8:32" },
  { text: "Love is patient, love is kind.", source: "1 Corinthians 13:4" },
  { text: "With God all things are possible.", source: "Matthew 19:26" },
  { text: "Do to others as you would have them do to you.", source: "Luke 6:31" },
  { text: "The light shines in the darkness, and the darkness has not overcome it.", source: "John 1:5" },
  { text: "Ask and it will be given to you.", source: "Matthew 7:7" },
  { text: "Be kind to one another.", source: "Ephesians 4:32" },
  { text: "The Spirit of God dwells in you.", source: "1 Corinthians 3:16" },
  { text: "Your word is a lamp to my feet.", source: "Psalm 119:105" },
  { text: "Jesus Christ is the same yesterday and today and forever.", source: "Hebrews 13:8" },
  { text: "Be joyful in hope, patient in affliction.", source: "Romans 12:12" },
  { text: "The name of the Lord is a strong tower.", source: "Proverbs 18:10" },
  { text: "He heals the brokenhearted.", source: "Psalm 34:18" },
  { text: "Walk by faith, not by sight.", source: "2 Corinthians 5:7" },
  { text: "The Lord is near to the brokenhearted.", source: "Psalm 34:18" },
  { text: "All things work together for good.", source: "Romans 8:28" },
  { text: "Whoever believes in me shall have eternal life.", source: "John 6:47" },
  { text: "Let your light shine before others.", source: "Matthew 5:16" },
  { text: "Peace I leave with you; my peace I give you.", source: "John 14:27" },
  { text: "Come to me, all who are weary.", source: "Matthew 11:28" },
  { text: "For where two or three gather, I am there among them.", source: "Matthew 18:20" },
  { text: "This is the day the Lord has made.", source: "Psalm 118:24" },
  { text: "Be transformed by the renewing of your mind.", source: "Romans 12:2" },
  { text: "The Lord is my light and my salvation.", source: "Psalm 27:1" },
  { text: "Your love never fails.", source: "1 Corinthians 13:8" },
  { text: "I am the way, the truth, and the life.", source: "John 14:6" },
  { text: "The kingdom of God is within you.", source: "Luke 17:21" },
  { text: "Hold fast to the word of life.", source: "Philippians 2:16" },
  { text: "The Lord will fight for you.", source: "Exodus 14:14" },
  { text: "Be devoted to one another in love.", source: "Romans 12:10" },
  { text: "My grace is sufficient for you.", source: "2 Corinthians 12:9" },
  { text: "You are the light of the world.", source: "Matthew 5:14" },
  { text: "Hope does not put us to shame.", source: "Romans 5:5" },
  { text: "The Lord is patient with you.", source: "2 Peter 3:9" },
  { text: "Seek first the kingdom of God.", source: "Matthew 6:33" },
  { text: "Whoever loves God must also love their brother.", source: "1 John 4:21" },
  { text: "God so loved the world.", source: "John 3:16" },
  { text: "Live by the Spirit.", source: "Galatians 5:25" },
  { text: "The fruit of the Spirit is love.", source: "Galatians 5:22" },
  { text: "Christ in you, the hope of glory.", source: "Colossians 1:27" },
  { text: "We walk by faith, not by sight.", source: "2 Corinthians 5:7" },
  { text: "The word of God is living and active.", source: "Hebrews 4:12" },
  { text: "Call upon me in the day of trouble.", source: "Psalm 50:15" },
  { text: "Delight yourself in the Lord.", source: "Psalm 37:4" },
  { text: "He commandeth his love toward us.", source: "Romans 5:8" },
  { text: "In all things God works for the good.", source: "Romans 8:28" },
  { text: "Be holy, for I am holy.", source: "1 Peter 1:16" },
  { text: "Godliness with contentment is great gain.", source: "1 Timothy 6:6" },
  { text: "The eternal God is your refuge.", source: "Deuteronomy 33:27" },
  { text: "Commit your work to the Lord.", source: "Proverbs 16:3" },
  { text: "Taste and see that the Lord is good.", source: "Psalm 34:8" },
  { text: "The Lord reigns forever.", source: "Psalm 146:10" },
  { text: "Give thanks to the Lord, for he is good.", source: "Psalm 136:1" },
  { text: "His mercies are new every morning.", source: "Lamentations 3:23" },
  { text: "The Lord is slow to anger and great in power.", source: "Nahum 1:3" },
  { text: "Wait for the Lord.", source: "Psalm 27:14" },
  { text: "The Lord directs our steps.", source: "Proverbs 20:24" },
  { text: "In him we live and move and have our being.", source: "Acts 17:28" },
  { text: "The Lord is trustworthy.", source: "Psalm 78:14" },
  { text: "Pour out your heart to him.", source: "Psalm 62:8" },
  { text: "Those who hope in him will not be put to shame.", source: "Romans 10:11" },
  { text: "The Lord is our righteousness.", source: "Jeremiah 23:6" },
  { text: "We are more than conquerors.", source: "Romans 8:37" },
  { text: "The Lord keeps us from all harm.", source: "Psalm 121:7" },
  { text: "Surely his salvation is near to those who fear him.", source: "Psalm 85:9" },
  { text: "The Lord is a refuge for the oppressed.", source: "Psalm 9:9" },
  { text: "Our heart finds rest in God alone.", source: "Psalm 131:2" },
  { text: "The Lord is good to all.", source: "Psalm 145:9" },
  { text: "He tends his flock like a shepherd.", source: "Isaiah 40:11" },
  { text: "Rise up, O Lord.", source: "Psalm 9:19" },
  { text: "The Lord is my rock and my fortress.", source: "Psalm 18:2" },
  { text: "We have this treasure in jars of clay.", source: "2 Corinthians 4:7" },
  { text: "To be self-controlled and pure.", source: "Titus 2:5" },
  { text: "The grace of the Lord Jesus Christ be with you.", source: "1 Corinthians 16:24" },
  { text: "The Lord has done great things for us.", source: "Psalm 126:3" },
  { text: "Be strong in the grace that is in Christ Jesus.", source: "2 Timothy 2:1" },
  { text: "The love of the Lord is from everlasting to everlasting.", source: "Psalm 103:17" },
  { text: "The Lord is our example.", source: "John 13:15" },
  { text: "To live is Christ and to die is gain.", source: "Philippians 1:21" },
  { text: "The Spirit bears witness with our spirit.", source: "Romans 8:16" },
  { text: "We have the mind of Christ.", source: "1 Corinthians 2:16" },
  { text: "The Word became flesh and dwelt among us.", source: "John 1:14" },
  { text: "The gift of God is eternal life.", source: "Romans 6:23" },
  { text: "Be strong and take heart.", source: "Psalm 31:24" },
  { text: "The Lord watches over you.", source: "Psalm 121:5" },
  { text: "The Lord is our peace.", source: "Judges 6:24" }
];

const getTodayVerse = () => {
  const today = new Date().toISOString().split('T')[0];
  const seed = today.split('-').join('') + today.split('-')[1];
  const idx = parseInt(seed, 10) % BIBLE_VERSES.length;
  return BIBLE_VERSES[idx];
};

// ============================================================
// LoginScreen — email/password + Google sign-in
// ============================================================
function LoginScreen({ onEmailLogin, onGoogleLogin, onForgotPassword, error, loading }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  const submitEmail = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    await onEmailLogin(email, password);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 flex items-center justify-center p-4 font-sans">
      <div className="bg-white rounded-[2rem] shadow-2xl max-w-md w-full p-8 border border-amber-100">
        <div className="text-center mb-8">
          <img src="/icon-192.png" alt="Family Hub X" className="w-24 h-24 mx-auto mb-4 rounded-2xl shadow-md" />
          <h1 className="text-3xl font-bold text-slate-800">Family Hub X</h1>
          <p className="text-xs text-slate-500 mt-1 uppercase tracking-widest">家庭共享日曆</p>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 p-3 rounded-xl mb-4 text-sm border border-red-100">
            {error}
          </div>
        )}

        <form onSubmit={submitEmail} className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
            required
            autoComplete="email"
          />
          <div className="relative">
            <input
              type={showPwd ? 'text' : 'password'}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className="w-full px-4 py-3 pr-12 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
              required
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPwd(!showPwd)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold"
            >
              {showPwd ? 'HIDE' : 'SHOW'}
            </button>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-amber-500 text-white py-3 rounded-xl font-bold hover:bg-amber-600 active:scale-[0.98] disabled:opacity-50 transition-all shadow-md"
          >
            {loading ? '登入中…' : '登入'}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-slate-400 font-bold">或</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        <button
          onClick={onGoogleLogin}
          disabled={loading}
          className="w-full border border-slate-200 py-3 rounded-xl font-bold text-slate-700 hover:bg-slate-50 active:scale-[0.98] disabled:opacity-50 transition-all flex items-center justify-center gap-2"
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          用 Google 帳戶登入
        </button>

        <div className="text-center mt-6 space-y-2">
          <button
            onClick={() => {
              if (!email) {
                onForgotPassword('', '先輸入 email');
                return;
              }
              onForgotPassword(email);
            }}
            className="text-amber-600 hover:underline text-sm font-bold"
          >
            忘記密碼？
          </button>
          <p className="text-[10px] text-slate-400">
            Family Hub X · v{APP_VERSION}
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// InviteAdultModal — call Cloud Function inviteMember
// ============================================================
function InviteAdultModal({ hubKey, functions, onClose, onResult }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const valid = email && email.includes('@') && displayName;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const fn = httpsCallable(functions, 'inviteMember');
      const res = await fn({ email, display_name: displayName, role });
      onResult(res.data);
      onClose();
    } catch (e) {
      console.error('inviteMember failed:', e);
      setError(e.message || 'Invite failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-3">
      <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden">
        <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-indigo-50 to-blue-50">
          <div className="flex items-center gap-2">
            <UserPlus size={18} className="text-indigo-600" />
            <h2 className="text-sm font-bold text-slate-900 uppercase">Invite Adult</h2>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 text-slate-300 bg-white rounded-xl disabled:opacity-30"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-xs text-slate-500">Creates a Firebase Auth user + member doc. We'll email them a setup link automatically.</p>
          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus disabled={busy}
              placeholder="person@example.com"
              className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Display name</label>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} disabled={busy}
              placeholder="e.g. Hattie"
              className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Role</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {['admin', 'member'].map(r => (
                <button key={r} onClick={() => setRole(r)} disabled={busy}
                  className={`py-3 rounded-xl text-xs font-bold uppercase border-2 transition-all disabled:opacity-50 ${
                    role === r ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200'
                  }`}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-xl p-3">{error}</p>
          )}
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold uppercase disabled:opacity-50">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!valid || busy}
              className="flex-1 py-3 bg-indigo-600 text-white rounded-xl text-xs font-bold uppercase active:scale-95 disabled:opacity-40 shadow-md flex items-center justify-center gap-2"
            >
              {busy ? <><RefreshCw size={14} className="animate-spin" /> Sending...</> : 'Send Invite'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// InviteChildModal — call Cloud Function inviteChild
// ============================================================
function InviteChildModal({ hubKey, kids, functions, onClose, onResult }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [kidId, setKidId] = useState(kids[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const usernameValid = /^[a-z0-9_]{3,20}$/.test(username);
  const valid = usernameValid && displayName && kidId;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const fn = httpsCallable(functions, 'inviteChild');
      const res = await fn({ username, display_name: displayName, bound_kid_id: kidId });
      onResult(res.data);
      onClose();
    } catch (e) {
      console.error('inviteChild failed:', e);
      setError(e.message || 'Invite failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-3">
      <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden">
        <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-amber-50 to-orange-50">
          <div className="flex items-center gap-2">
            <UserPlus size={18} className="text-amber-600" />
            <h2 className="text-sm font-bold text-slate-900 uppercase">Invite Child</h2>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 text-slate-300 bg-white rounded-xl disabled:opacity-30"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-xs text-slate-500">Username becomes synthetic email <code className="bg-slate-100 px-1 rounded">@kids.fhx.app</code>. Bound to a kid record so child can only edit their own schedule.</p>
          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Username (3-20 chars, lowercase)</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value.toLowerCase())} autoFocus disabled={busy}
              placeholder="eugene"
              className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50" />
            {username && !usernameValid && (
              <p className="text-[10px] text-red-500 mt-1">3-20 chars, lowercase letters/digits/underscore only</p>
            )}
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Display name</label>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} disabled={busy}
              placeholder="e.g. Eugene"
              className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Bind to kid</label>
            <select value={kidId} onChange={e => setKidId(e.target.value)} disabled={busy}
              className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50">
              {kids.map(k => (
                <option key={k.id} value={k.id}>{k.name} · {k.grade || '?'}{k.className ? `/${k.className}` : ''}</option>
              ))}
            </select>
          </div>
          {error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-xl p-3">{error}</p>
          )}
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold uppercase disabled:opacity-50">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!valid || busy}
              className="flex-1 py-3 bg-amber-500 text-white rounded-xl text-xs font-bold uppercase active:scale-95 disabled:opacity-40 shadow-md flex items-center justify-center gap-2"
            >
              {busy ? <><RefreshCw size={14} className="animate-spin" /> Sending...</> : 'Send Invite'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// InviteResultModal — show setup link after invite sent
// ============================================================
function InviteResultModal({ result, onClose }) {
  const [copied, setCopied] = useState(false);
  const emailOk = result.email_sent;
  const isChild = result.display_name && result.email && result.email.endsWith('@kids.fhx.app');
  const shareUrl = result.setup_link;
  const subject = isChild
    ? `Welcome to Family Hub X — set up ${result.display_name}'s account`
    : `Welcome to Family Hub X — set up your account`;
  const body = isChild
    ? `Hi,\n\n${result.display_name} has been invited to our Family Hub.\n\nClick here to set a password and get started:\n${shareUrl}\n\nThis link expires in 1 hour.\n\n— Family Hub X`
    : `Hi,\n\nYou've been invited to join our Family Hub on Family Hub X.\n\nClick here to set a password and get started:\n${shareUrl}\n\nThis link expires in 1 hour.\n\n— Family Hub X`;
  const mailto = `mailto:${result.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-3">
      <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden">
        <div className={`p-6 border-b flex justify-between items-center ${emailOk ? 'bg-gradient-to-r from-emerald-50 to-green-50' : 'bg-gradient-to-r from-amber-50 to-orange-50'}`}>
          <div className="flex items-center gap-2">
            {emailOk ? <CheckCircle2 size={18} className="text-emerald-600" /> : <Info size={18} className="text-amber-600" />}
            <h2 className="text-sm font-bold text-slate-900 uppercase">
              {emailOk ? 'Invite Sent' : 'Email Failed — Share Manually'}
            </h2>
          </div>
          <button onClick={onClose} className="p-2 text-slate-300 bg-white rounded-xl"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-3">
          <div className="text-xs text-slate-600 space-y-1">
            <p><strong>{result.display_name}</strong> ({result.email})</p>
            <p>Role: <strong>{result.role || 'child'}</strong> · {result.created ? 'New account created' : 'Existing user updated'}</p>
            {emailOk ? (
              <p className="text-emerald-700">✓ Email sent to {result.email}</p>
            ) : (
              <p className="text-amber-700">⚠ Email send failed: {result.email_error || 'SMTP not configured'}</p>
            )}
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Setup link (1-hour expiry)</label>
            <div className="bg-slate-900 text-green-400 p-3 rounded-xl font-mono text-[10px] break-all leading-relaxed mt-1 max-h-32 overflow-y-auto">
              {shareUrl}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="py-3 bg-indigo-600 text-white rounded-xl text-xs font-bold uppercase active:scale-95 flex items-center justify-center gap-2"
            >
              <Copy size={14} /> {copied ? 'Copied!' : 'Copy link'}
            </button>
            <a href={mailto}
              className="py-3 bg-emerald-600 text-white rounded-xl text-xs font-bold uppercase active:scale-95 flex items-center justify-center gap-2 no-underline">
              <Send size={14} /> Email via…
            </a>
          </div>

          <p className="text-[10px] text-slate-400 leading-relaxed">
            {emailOk
              ? 'Email already sent. You can also copy and share the link manually (WhatsApp, SMS) if they don\'t see the email.'
              : 'SMTP not configured or failed. Send the setup link via WhatsApp / SMS / your own email client.'}
          </p>
          <button onClick={onClose}
            className="w-full py-2 text-slate-400 text-[10px] font-bold uppercase">Done</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [isConfigReady, setIsConfigReady] = useState(false);
  const [user, setUser] = useState(null);
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [appId] = useState('family-hub-v2');

  // Active profile is derived from Firebase Auth user's custom claims
  // (hub_key + role + display_name from members doc).
  const [activeProfile, setActiveProfile] = useState(null);

  const [activeTab, setActiveTab] = useState('schedule');
  const [meals, setMeals] = useState([]);
  const [groceries, setGroceries] = useState([]);
  const [dishes, setDishes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  const [todayVerse] = useState(getTodayVerse);

  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [currentCategoryId, setCurrentCategoryId] = useState(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newDishName, setNewDishName] = useState('');
  const [selectingFor, setSelectingFor] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importPendingList, setImportPendingList] = useState([]);

  const [editingRemark, setEditingRemark] = useState(null);
  const [manualInputs, setManualInputs] = useState({});
  const [newGrocery, setNewGrocery] = useState('');
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');


  // Settings page state
  const [editingProfileName, setEditingProfileName] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [hubProfile, setHubProfile] = useState(null);  // { name, createdAt, ... }
  const [editingHubName, setEditingHubName] = useState(false);
  const [hubNameDraft, setHubNameDraft] = useState('');
  // Change password modal
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [changePwdError, setChangePwdError] = useState(null);
  const [changePwdLoading, setChangePwdLoading] = useState(false);
  // Members UI state (admin only)
  const [members, setMembers] = useState([]);
  const [membersKids, setMembersKids] = useState([]);
  const [inviteAdultOpen, setInviteAdultOpen] = useState(false);
  const [inviteChildOpen, setInviteChildOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);  // { setup_link, email_sent, email_error, ... }

  // ===== School module state =====
  const [kids, setKids] = useState([]);
  const [kidForm, setKidForm] = useState(blankKid);
  const [showKidForm, setShowKidForm] = useState(false);
  const [editingKidId, setEditingKidId] = useState(null);
  // Snapshot of bulk reminders when kid form opens — used to detect changes made during this edit session.
  // Bulk reminders save directly to Firestore (per-date docs) on modal Save, not via the kid form's Save button.
  // So computeKidDiff would otherwise report "no changes" even when reminders were added.
  const originalBulkRemindersRef = useRef(null);

  // Daily notes (ECA / Test / To-bring / Reminder) — per kid per date
  const [dailyNotes, setDailyNotes] = useState({}); // { [kidId]: { eca, test, to_bring, reminder } }
  const [editingNoteKidId, setEditingNoteKidId] = useState(null);
  const [sheetDraft, setSheetDraft] = useState(null);

  // PIN-confirmed kid delete
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // Pending kid-save confirmation: { payload, diff } — when set, show the diff dialog
  const [confirmKidSave, setConfirmKidSave] = useState(null); // { kid, pinDraft } | null
  const [deletePinError, setDeletePinError] = useState(null);

  // Toast notification (replaces silent-return handlers that confused users)
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = (message, tone = 'info') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone, id: Date.now() });
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  };

  const firebaseRefs = useMemo(() => {
    try {
      const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
      return { auth: getAuth(app), db: getFirestore(app), functions: getFunctions(app, 'us-central1') };
    } catch (e) {
      console.error('Firebase init error:', e);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!firebaseRefs) return;
    const { auth, db } = firebaseRefs;

    // Watch auth state. If signed in, fetch fresh custom claims to derive
    // activeProfile (hub_key + role). If no user, show LoginScreen.
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setActiveProfile(null);
        setIsConfigReady(true);
        return;
      }
      // Phase 5: no anonymous users. Force sign-out if cached.
      if (u.isAnonymous) {
        try { await signOut(auth); } catch {}
        return;
      }
      try {
        // Force token refresh so latest custom claims are present.
        const tokenResult = await u.getIdTokenResult(true);
        const claims = tokenResult.claims || {};
        if (claims.hub_key && claims.role === 'admin' && claims.status === 'active') {
          setUser(u);
          setActiveProfile({
            uid: u.uid,
            email: u.email,
            hubKey: claims.hub_key,
            role: claims.role,
            name: u.displayName || claims.hub_key,
          });
          setLoginError(null);
          // Self-clear needs_password_setup after successful password login
          clearPasswordSetupFlag(db, appId, claims.hub_key, u.uid);
        } else if (claims.hub_key && (claims.role === 'member' || claims.role === 'child') && claims.status === 'active') {
          // Future Phase 3/4: member + child support
          setUser(u);
          setActiveProfile({
            uid: u.uid,
            email: u.email,
            hubKey: claims.hub_key,
            role: claims.role,
            name: u.displayName || claims.hub_key,
            boundKidId: claims.bound_kid_id,
          });
          setLoginError(null);
          clearPasswordSetupFlag(db, appId, claims.hub_key, u.uid);
        } else {
          console.warn('User signed in but missing/insufficient claims:', claims);
          setUser(u);
          setActiveProfile(null);
          setLoginError(`Account not linked to a hub. Please contact admin. (claims: ${JSON.stringify(Object.keys(claims))})`);
        }
      } catch (e) {
        console.error('Token refresh failed:', e);
        setLoginError('Authentication error: ' + (e.message || 'unknown'));
        setUser(null);
        setActiveProfile(null);
      } finally {
        setIsConfigReady(true);
      }
    });
    return unsub;
  }, [firebaseRefs]);

  useEffect(() => {
    if (!user || !activeProfile || !firebaseRefs) return;
    const { db } = firebaseRefs;
    const root = ['artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey];

    const subs = [
      // Hub profile (name + settings)
      onSnapshot(doc(db, ...root), (s) => setHubProfile(s.exists() ? s.data() : null)),
      onSnapshot(collection(db, ...root, 'meals'), (s) => setMeals(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, ...root, 'groceries'), (s) => setGroceries(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, ...root, 'dishes'), (s) => setDishes(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, ...root, 'categories'), (s) => setCategories(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, ...root, 'kids'), (s) => setKids(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      // Settings: subscribe to PINs belonging to this hub so user can manage them
      onSnapshot(
        query(collection(db, 'artifacts', appId, 'public', 'data', 'pins'), where('hubKey', '==', activeProfile.hubKey)),
        (s) => setExistingPins(s.docs.map(d => ({ pin: d.id, ...d.data() })))
      ),
      // Members (admin reads all members)
      onSnapshot(collection(db, ...root, 'members'), (s) => setMembers(s.docs.map(d => ({ uid: d.id, ...d.data() }))))
    ];

    return () => subs.forEach(unsub => unsub());
  }, [user, activeProfile, firebaseRefs, appId]);

  // Subscribe to daily-notes per kid for current selectedDate
  useEffect(() => {
    if (!user || !activeProfile || !firebaseRefs || kids.length === 0) return;
    const { db } = firebaseRefs;
    const basePath = ['artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids'];
    const subs = kids.map(kid => {
      const ref = doc(db, ...basePath, kid.id, 'daily-notes', selectedDate);
      return onSnapshot(ref, (snap) => {
        setDailyNotes(prev => ({ ...prev, [kid.id]: snap.exists() ? snap.data() : {} }));
      });
    });
    return () => subs.forEach(unsub => unsub());
  }, [user, activeProfile, firebaseRefs, appId, kids, selectedDate]);

  // Bulk reminders per kid (sub-collection reminders/{YYYY-MM-DD} → auto reminder source)
  const [bulkReminders, setBulkReminders] = useState({}); // { kidId: { 'YYYY-MM-DD': 'text' } }
  useEffect(() => {
    if (!user || !activeProfile || !firebaseRefs || kids.length === 0) return;
    const { db } = firebaseRefs;
    const basePath = ['artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids'];
    const subs = kids.map(kid => {
      const ref = collection(db, ...basePath, kid.id, 'reminders');
      return onSnapshot(ref, (snap) => {
        const map = {};
        snap.docs.forEach(d => { const dt = d.data(); if (dt?.text) map[d.id] = dt.text; });
        setBulkReminders(prev => ({ ...prev, [kid.id]: map }));
      });
    });
    return () => subs.forEach(unsub => unsub());
  }, [user, activeProfile, firebaseRefs, appId, kids]);

  const getAutoReminderText = (kidId, dateStr) => {
    const m = bulkReminders[kidId];
    return (m && m[dateStr]) ? m[dateStr] : null;
  };

  // Daily Note reads directly from Firestore state (used as initial value for uncontrolled textarea)
  const dailyNoteFromDB = (meals || []).find(m => m.id === `${selectedDate}_planner`)?.note || '';

  const getHubRef = (col, docId = null) => {
    if (!activeProfile || !firebaseRefs) return null;
    const c = collection(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, col);
    return docId ? doc(c, docId) : c;
  };

  const handleQuickLogin = async () => {
    if (quickCode.length < 4) {
      setLoginError("Enter a PIN (at least 4 digits)");
      return;
    }
    try {
      const snap = await getDoc(doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'pins', quickCode));
      if (snap.exists()) {
        const d = snap.data();
        const p = { hubKey: d.hubKey, name: d.name, phone: d.phone };
        localStorage.setItem('family_app_profile', JSON.stringify(p));
        setActiveProfile(p);
        setLoginError(null);
      } else { setLoginError("Invalid PIN"); }
    } catch (e) { setLoginError("Login Error"); }
  };

  // ─── Settings handlers ──────────────────────────────────────────────────────
  const handleSaveProfileName = async () => {
    const newName = profileNameDraft.trim();
    if (!newName || newName === activeProfile.name) {
      setEditingProfileName(false);
      return;
    }
    if (newName.length > 30) {
      showToast('Name too long (max 30)', 'warn');
      return;
    }
    try {
      // 1) Update Firebase Auth displayName
      await updateProfile(firebaseRefs.auth.currentUser, { displayName: newName });
      // 2) Update member doc display_name for consistency
      const memberRef = doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'members', activeProfile.uid);
      await updateDoc(memberRef, { display_name: newName });
      // 3) Update local state
      setActiveProfile({ ...activeProfile, name: newName });
      setEditingProfileName(false);
      setProfileNameDraft('');
      showToast('Display name updated', 'success');
    } catch (e) {
      console.error('Display name update failed:', e);
      showToast('Failed: ' + (e.message || 'unknown'), 'error');
    }
  };

  const handleSaveHubName = async () => {
    const newName = hubNameDraft.trim();
    if (!newName || newName === hubProfile?.profile?.name) {
      setEditingHubName(false);
      return;
    }
    if (newName.length > 30) {
      showToast('Hub name too long (max 30)', 'warn');
      return;
    }
    try {
      const ref = doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey);
      await updateDoc(ref, {
        'profile.name': newName,
        'profile.updated_at': new Date().toISOString(),
      });
      setEditingHubName(false);
      setHubNameDraft('');
      showToast('Hub name updated', 'success');
    } catch (e) {
      console.error('Hub name update failed:', e);
      showToast('Failed: ' + (e.message || 'unknown'), 'error');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(firebaseRefs.auth);
    } catch (e) { console.error('Sign out error:', e); }
    // onAuthStateChanged will fire and reset user + activeProfile
    setConfirmLogout(false);
  };

  // ===== Login handlers (Phase 5) =====
  const handleEmailLogin = async (email, password) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      await signInWithEmailAndPassword(firebaseRefs.auth, email, password);
      // onAuthStateChanged will fetch claims and enter app
    } catch (e) {
      const code = e?.code || '';
      const msg = code === 'auth/invalid-credential' ? 'Email 或密碼不正確' :
                  code === 'auth/user-disabled' ? '此帳戶已被停用' :
                  code === 'auth/too-many-requests' ? '嘗試太多次，稍後再試' :
                  (e?.message || '登入失敗');
      setLoginError(msg);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(firebaseRefs.auth, provider);
    } catch (e) {
      const code = e?.code || '';
      if (code === 'auth/popup-closed-by-user') {
        // User cancelled — silent
      } else if (code === 'auth/account-exists-with-different-credential') {
        setLoginError('此 email 已用其他方法註冊');
      } else {
        setLoginError('Google 登入失敗：' + (e?.message || 'unknown'));
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleForgotPassword = async (email) => {
    if (!email) {
      setLoginError('先輸入 email 再 reset');
      return;
    }
    try {
      await sendPasswordResetEmail(firebaseRefs.auth, email);
      setLoginError(null);
      alert('Reset link 已寄到 ' + email + '，請檢查 inbox');
    } catch (e) {
      setLoginError('Reset 失敗：' + (e?.message || 'unknown'));
    }
  };

  const handleChangePassword = async (currentPwd, newPwd) => {
    if (!user || !user.email) return { ok: false, error: 'Not signed in' };
    if (newPwd.length < 8) return { ok: false, error: '密碼至少 8 個字元' };
    try {
      // Re-authenticate first (Firebase requires recent login for password change)
      const { EmailAuthProvider, reauthenticateWithCredential } = await import('firebase/auth');
      const credential = EmailAuthProvider.credential(user.email, currentPwd);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPwd);
      return { ok: true };
    } catch (e) {
      const code = e?.code || '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        return { ok: false, error: '現有密碼不正確' };
      }
      if (code === 'auth/requires-recent-login') {
        return { ok: false, error: '請先 logout 再 login，然後立即改密碼' };
      }
      return { ok: false, error: e?.message || '改密碼失敗' };
    }
  };

  // ─── Kids (school module) ──────────────────────────────────────────────────
  const openKidForm = (kid = null) => {
    if (kid) {
      const existingUs = kid.uniform_schedule || blankUniformSchedule();
      // Backfill rotation_length from rotation.length for older kids
      const us = { rotation_length: existingUs.rotation_length || existingUs.rotation?.length || 7, ...existingUs };
      // Normalize Chinese dress-code values to English in form state, so <select> options match
      const normalizeWeekdayMap = (wm) => {
        if (!wm) return wm;
        const out = {};
        for (const [k, v] of Object.entries(wm)) out[k] = translateDressCode(v) || v || 'Uniform';
        return out;
      };
      const normalizeRotation = (rot) => Array.isArray(rot) ? rot.map(r => ({
        ...r,
        uniform: translateDressCode(r.uniform) || r.uniform || 'Uniform',
      })) : rot;
      const usNormalized = {
        ...us,
        weekday_map: normalizeWeekdayMap(us.weekday_map),
        rotation: normalizeRotation(us.rotation),
      };
      setKidForm({
        ...blankKid,
        ...kid,
        school_holidays: kid.school_holidays || [],
        exam_dates: kid.exam_dates || [],
        special_dates: kid.special_dates || [],
        eca_recurring: kid.eca_recurring || [],
        uniform_schedule: usNormalized,
        school_phone: kid.school_phone || '',
        student_no: kid.student_no || '',
      });
      setEditingKidId(kid.id);
      originalBulkRemindersRef.current = { ...(bulkReminders[kid.id] || {}) };
    } else {
      setKidForm({ ...blankKid, uniform_schedule: blankUniformSchedule(), school_holidays: [], eca_recurring: [] });
      setEditingKidId(null);
      originalBulkRemindersRef.current = null;
    }
    setExpandedEcaDates(new Set());  // reset expand state — ECA indices are per-form
    setShowKidForm(true);
  };

  // ECA recurring helpers (form state)
  const addEcaRow = () => setKidForm(prev => ({
    ...prev,
    eca_recurring: [
      ...(prev.eca_recurring || []),
      { name: '', dates: [], start_time: '', end_time: '', dress_code: 'not_specified' }
    ]
  }));
  const updateEcaRow = (idx, newEca) => setKidForm(prev => {
    const list = [...(prev.eca_recurring || [])];
    list[idx] = newEca;
    return { ...prev, eca_recurring: list };
  });
  const removeEcaRow = (idx) => setKidForm(prev => ({
    ...prev,
    eca_recurring: (prev.eca_recurring || []).filter((_, i) => i !== idx)
  }));
  // Confirm before deleting a whole ECA row (the X next to the ECA name wipes the entire activity)
  const askRemoveEcaRow = (idx) => {
    const eca = (kidForm.eca_recurring || [])[idx];
    const label = (eca?.name || '').trim() || 'this ECA';
    const dateCount = (eca?.dates || []).length;
    const msg = `Delete ${label}?` +
      (dateCount ? `\n\nThis removes the whole ECA and its ${dateCount} class date(s).` : '\n\nThis removes the whole ECA.') +
      `\n\nIt only takes effect after you press Save Changes.`;
    if (window.confirm(msg)) removeEcaRow(idx);
  };

  // Calendar multi-select state for ECA dates (only one open at a time, toggles dates[] directly)
  const [skipCalIdx, setSkipCalIdx] = useState(null);
  const [skipCalView, setSkipCalView] = useState({ y: new Date().getFullYear(), m: new Date().getMonth() });
  const [skipCalRange, setSkipCalRange] = useState({ from: '', to: '', weekday: '' });

  // ── Bulk Reminder modal (separate state from ECA calendar picker) ──
  const [bulkReminderModal, setBulkReminderModal] = useState(null); // { kidId, mode: 'new'|'edit', date?: string, dates: Set<string>, text: string }
  const [bulkReminderCalView, setBulkReminderCalView] = useState({ y: new Date().getFullYear(), m: new Date().getMonth() });
  const [bulkReminderCalRange, setBulkReminderCalRange] = useState({ from: '', to: '' });

  // ECA dates list — per-ECA expand/shrink state (collapsed by default; first 12 chips shown)
  const [expandedEcaDates, setExpandedEcaDates] = useState(new Set());
  const [expandedBulkReminderGroups, setExpandedBulkReminderGroups] = useState(new Set());
  const toggleBulkReminderExpand = (text) => {
    setExpandedBulkReminderGroups(prev => {
      const next = new Set(prev);
      if (next.has(text)) next.delete(text); else next.add(text);
      return next;
    });
  };
  const toggleEcaExpand = (idx) => setExpandedEcaDates(prev => {
    const next = new Set(prev);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    return next;
  });

  // Calendar multi-select state for School holidays — moved into DatePickerSection component

  // Build kid payload from form state (no save side-effects)
  const buildKidPayload = () => {
    const name = kidForm.name.trim();
    const avatar = kidForm.avatar?.trim() || name.charAt(0).toUpperCase() || '';
    const us = kidForm.uniform_schedule || blankUniformSchedule();
    const usWithLen = { rotation_length: us.rotation_length || us.rotation?.length || 7, ...us };
    if (usWithLen.type === 'cycle' && Array.isArray(usWithLen.rotation)) {
      const len = usWithLen.rotation_length || usWithLen.rotation.length;
      usWithLen.rotation = Array.from({ length: len }, (_, i) => {
        const existing = usWithLen.rotation[i] || { day: i + 1 };
        return { day: i + 1, uniform: existing.uniform || 'Uniform', note: existing.note || '' };
      });
      usWithLen.rotation_length = len;
    }
    const ecaClean = (kidForm.eca_recurring || []).filter(e => (e?.name || '').trim());
    return {
      name,
      school: kidForm.school.trim(),
      school_phone: kidForm.school_phone.trim(),
      grade: kidForm.grade,
      className: kidForm.className.trim(),
      student_no: kidForm.student_no.trim(),
      color: kidForm.color || 'indigo',
      avatar,
      avatar_data: kidForm.avatar_data || '',
      uniform_schedule: usWithLen,
      school_holidays: kidForm.school_holidays || [],
      exam_dates: kidForm.exam_dates || [],
      special_dates: kidForm.special_dates || [],
      eca_recurring: ecaClean,
      updatedAt: Date.now(),
    };
  };

  // Compute field-level diff between original kid and new payload (for confirm dialog)
  const computeKidDiff = (original, payload) => {
    if (!original) return [{ key: '_new', label: 'New kid', old: '', new: payload.name }];
    const changes = [];
    const cmp = (key, label, category, fmt = (v) => v == null || v === '' ? '∅' : String(v)) => {
      const o = original[key];
      const n = payload[key];
      if (JSON.stringify(o ?? null) !== JSON.stringify(n ?? null)) {
        changes.push({ key, label, category, old: fmt(o), new: fmt(n) });
      }
    };
    cmp('name', 'Name', 'Profile');
    cmp('school', 'School', 'Profile');
    cmp('school_phone', 'School phone', 'Profile');
    cmp('grade', 'Grade', 'Profile');
    cmp('className', 'Class', 'Profile');
    cmp('student_no', 'Student #', 'Profile');
    cmp('color', 'Color', 'Profile');
    cmp('avatar', 'Avatar letter', 'Profile');
    cmp('avatar_data', 'Avatar image', 'Profile', () => payload.avatar_data ? '(image set)' : '∅');
    // Uniform schedule — summarize
    const oldUS = original.uniform_schedule || {};
    const newUS = payload.uniform_schedule || {};
    if (JSON.stringify({ t: oldUS.type, sd: oldUS.start_date, rl: oldUS.rotation_length, rot: oldUS.rotation }) !==
        JSON.stringify({ t: newUS.type, sd: newUS.start_date, rl: newUS.rotation_length, rot: newUS.rotation })) {
      changes.push({
        key: 'uniform_schedule',
        label: 'Uniform cycle',
        category: 'Schedule',
        old: `${oldUS.type || 'fixed'}${oldUS.start_date ? ` from ${oldUS.start_date}` : ''}`,
        new: `${newUS.type || 'fixed'}${newUS.start_date ? ` from ${newUS.start_date}` : ''}`,
      });
    }
    const cmpArr = (key, label) => {
      const o = (original[key] || []).slice().sort();
      const n = (payload[key] || []).slice().sort();
      if (JSON.stringify(o) !== JSON.stringify(n)) {
        const added = n.filter(d => !o.includes(d));
        const removed = o.filter(d => !n.includes(d));
        const parts = [`${o.length} → ${n.length} dates`];
        if (added.length) parts.push(`+${added.length}: ${added.slice(0,3).join(', ')}${added.length>3?'…':''}`);
        if (removed.length) parts.push(`-${removed.length}: ${removed.slice(0,3).join(', ')}${removed.length>3?'…':''}`);
        changes.push({ key, label, category: 'Schedule', old: '', new: parts.join(' · ') });
      }
    };
    cmpArr('school_holidays', 'School holidays');
    cmpArr('exam_dates', 'Exam dates');
    cmpArr('special_dates', 'Special days');
    // ECAs
    const oldECAs = original.eca_recurring || [];
    const newECAs = payload.eca_recurring || [];
    const oldNames = new Set(oldECAs.map(e => e.name));
    const newNames = new Set(newECAs.map(e => e.name));
    const addedECAs = [...newNames].filter(n => !oldNames.has(n));
    const removedECAs = [...oldNames].filter(n => !newNames.has(n));
    const updatedECAs = [];
    for (const newE of newECAs) {
      const oldE = oldECAs.find(e => e.name === newE.name);
      // NOTE: must compare end_time too — otherwise changing only end_time shows "No changes".
      if (oldE && JSON.stringify({ d: oldE.dates, t: oldE.start_time, e: oldE.end_time, dc: oldE.dress_code }) !==
                 JSON.stringify({ d: newE.dates, t: newE.start_time, e: newE.end_time, dc: newE.dress_code })) {
        updatedECAs.push(newE.name);
      }
    }
    if (addedECAs.length || removedECAs.length || updatedECAs.length) {
      const parts = [];
      if (addedECAs.length) parts.push(`+${addedECAs.length}: ${addedECAs.join(', ')}`);
      if (removedECAs.length) parts.push(`-${removedECAs.length}: ${removedECAs.join(', ')}`);
      if (updatedECAs.length) parts.push(`modified: ${updatedECAs.join(', ')}`);
      changes.push({ key: 'eca_recurring', label: 'ECAs', category: 'ECAs', old: `${oldECAs.length} ECA(s)`, new: parts.join(' · ') });
    }
    return changes;
  };

  const handleSaveKid = () => {
    const name = kidForm.name.trim();
    if (!name) { showToast('Kid name is required', 'warn'); return; }
    const payload = buildKidPayload();
    // For edits, compute diff for summary toast; for new kids, save directly
    if (editingKidId) {
      const originalKid = kids.find(k => k.id === editingKidId);
      const diff = computeKidDiff(originalKid, payload);
      // Detect bulk reminder changes during this edit session (they're saved directly to Firestore on modal save)
      const origBulk = originalBulkRemindersRef.current || {};
      const currBulk = bulkReminders[editingKidId] || {};
      const bulkChanged = JSON.stringify({ k: Object.keys(origBulk).sort(), v: Object.keys(origBulk).sort().map(d => origBulk[d]) }) !==
                          JSON.stringify({ k: Object.keys(currBulk).sort(), v: Object.keys(currBulk).sort().map(d => currBulk[d]) });
      if (diff.length === 0 && !bulkChanged) {
        showToast('No changes — keep editing', 'info');
        return;
      }
      if (diff.length === 0 && bulkChanged) {
        // Only bulk reminders changed — they're already saved to Firestore. Just close the form.
        showToast('Reminders saved', 'success');
        setShowKidForm(false);
        setConfirmKidSave(null);
        setKidForm(blankKid);
        setEditingKidId(null);
        originalBulkRemindersRef.current = null;
        return;
      }
      // Save directly (no confirm dialog — user found it confusing). Toast summarises changes.
      const summary = diff.map(c => c.label).slice(0, 3).join(', ') + (diff.length > 3 ? ` +${diff.length - 3} more` : '');
      performKidSave(payload, `Saved: ${summary}`);
    } else {
      performKidSave(payload);
    }
  };

  const performKidSave = async (payload, successMsg = 'Kid updated') => {
    if (!firebaseRefs || !activeProfile) { showToast('Not ready — try again', 'warn'); return; }
    try {
      if (editingKidId) {
        const ref = getHubRef('kids', editingKidId);
        // Build the patch: all payload fields except createdAt
        const patch = {};
        for (const [k, v] of Object.entries(payload)) {
          if (k === 'createdAt') continue;
          patch[k] = v;
        }
        await updateDoc(ref, patch);
        showToast(successMsg, 'success');
      } else {
        await addDoc(getHubRef('kids'), { ...payload, createdAt: Date.now() });
        showToast(successMsg === 'Kid updated' ? 'Kid added' : successMsg, 'success');
      }
      setShowKidForm(false);
      setConfirmKidSave(null);
      setKidForm(blankKid);
      setEditingKidId(null);
    } catch (e) {
      console.error('Save kid failed:', e);
      showToast('Save failed', 'error');
    }
  };

  // ── Bulk Reminder CRUD (separate from kid doc — own subcollection kids/{kidId}/reminders/{date}) ──
  const openBulkReminderModal = (existing /* { text } | null — when text is set, edit the whole group */) => {
    if (!editingKidId) {
      showToast('Save kid first before adding reminders', 'warn');
      return;
    }
    if (existing && existing.text !== undefined) {
      // Edit mode (group): load all dates with this text
      const datesArr = Object.entries(bulkReminders[editingKidId] || {})
        .filter(([_, t]) => t === existing.text)
        .map(([d]) => d)
        .sort();
      const datesSet = new Set(datesArr);
      setBulkReminderModal({
        kidId: editingKidId,
        mode: 'edit',
        dates: datesSet,
        text: existing.text,
        originalText: existing.text,
        originalDates: new Set(datesSet),
      });
      if (datesArr.length) {
        const d = new Date(datesArr[0] + 'T00:00:00');
        setBulkReminderCalView({ y: d.getFullYear(), m: d.getMonth() });
      }
    } else {
      // New mode: empty dates + empty text, view = today
      const today = new Date();
      setBulkReminderModal({
        kidId: editingKidId,
        mode: 'new',
        dates: new Set(),
        text: '',
        originalText: '',
        originalDates: new Set(),
      });
      setBulkReminderCalView({ y: today.getFullYear(), m: today.getMonth() });
    }
    setBulkReminderCalRange({ from: '', to: '' });
  };
  const closeBulkReminderModal = () => {
    setBulkReminderModal(null);
    setBulkReminderCalRange({ from: '', to: '' });
  };
  const toggleBulkReminderDate = (ds) => {
    setBulkReminderModal(prev => {
      const next = new Set(prev.dates);
      if (next.has(ds)) next.delete(ds); else next.add(ds);
      return { ...prev, dates: next };
    });
  };
  const addBulkReminderRange = () => {
    const { from, to } = bulkReminderCalRange;
    if (!from || !to) { showToast('Pick range dates first', 'warn'); return; }
    if (from > to) { showToast('From must be before To', 'warn'); return; }
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ey, em, ed] = to.split('-').map(Number);
    const added = [];
    for (let d = new Date(fy, fm - 1, fd); d <= new Date(ey, em - 1, ed); d.setDate(d.getDate() + 1)) {
      added.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    if (!added.length) { showToast('No dates in range', 'warn'); return; }
    setBulkReminderModal(prev => {
      const next = new Set(prev.dates);
      added.forEach(d => next.add(d));
      return { ...prev, dates: next };
    });
    showToast(`Added ${added.length} date(s)`, 'success');
    setBulkReminderCalRange({ from: '', to: '' });
  };
  const saveBulkReminderModal = async () => {
    if (!bulkReminderModal || !firebaseRefs) return;
    const { kidId, dates, text, originalText, originalDates } = bulkReminderModal;
    const cleanText = (text || '').trim();
    if (!cleanText) { showToast('Reminder text required', 'warn'); return; }
    if (dates.size === 0) { showToast('Pick at least 1 date', 'warn'); return; }
    const { db } = firebaseRefs;
    const basePath = ['artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids', kidId, 'reminders'];
    try {
      const writes = [...dates].map(d => setDoc(doc(db, ...basePath, d), { text: cleanText, updatedAt: Date.now() }));
      // Edit-mode cleanup: dates removed from this group AND no longer match any other text in DB → delete doc
      // (Don't blindly delete — if a date was reassigned to another text during this op, keep it.)
      const deletes = [];
      if (originalText !== undefined) {
        const allDocs = bulkReminders[kidId] || {};
        originalDates.forEach(d => {
          if (!dates.has(d)) {
            // This date is no longer in current group. Check if it has a different text elsewhere (shouldn't, but safe).
            if (allDocs[d] === originalText || allDocs[d] === undefined) {
              deletes.push(deleteDoc(doc(db, ...basePath, d)));
            }
          }
        });
      }
      await Promise.all([...writes, ...deletes]);
      const msg = `${dates.size} date(s) saved` + (deletes.length ? `, ${deletes.length} removed` : '');
      showToast(msg, 'success');
      closeBulkReminderModal();
    } catch (e) {
      console.error('Save bulk reminder failed:', e);
      showToast('Save failed', 'error');
    }
  };
  // Per-date delete (single doc)
  const deleteBulkReminder = async (date) => {
    if (!editingKidId || !firebaseRefs) return;
    if (!window.confirm(`Delete bulk reminder for ${date}?`)) return;
    try {
      const { db } = firebaseRefs;
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids', editingKidId, 'reminders', date));
      showToast('Bulk reminder deleted', 'success');
    } catch (e) {
      showToast('Delete failed', 'error');
    }
  };
  // Group delete (all docs sharing this text)
  const deleteBulkReminderGroup = async (text) => {
    if (!editingKidId || !firebaseRefs) return;
    const dates = Object.entries(bulkReminders[editingKidId] || {})
      .filter(([_, t]) => t === text)
      .map(([d]) => d);
    if (!dates.length) return;
    if (!window.confirm(`Delete "${text}" on ${dates.length} date(s)?`)) return;
    try {
      const { db } = firebaseRefs;
      const basePath = ['artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids', editingKidId, 'reminders'];
      await Promise.all(dates.map(d => deleteDoc(doc(db, ...basePath, d))));
      showToast(`Deleted ${dates.length} reminder(s)`, 'success');
    } catch (e) {
      showToast('Delete failed', 'error');
    }
  };

  const handleDeleteKid = async (kidId) => {
    if (!window.confirm('Delete this kid? Their school info will be removed.')) return;
    try {
      await deleteDoc(getHubRef('kids', kidId));
      showToast('Kid deleted', 'success');
    } catch (e) {
      showToast('Delete failed', 'error');
    }
  };

  // PIN-confirmed kid delete (trash icon → enter PIN to confirm)
  const openConfirmDelete = (kid) => {
    setDeleteConfirm({ kid, pinDraft: '' });
    setDeletePinError(null);
  };
  const cancelConfirmDelete = () => {
    setDeleteConfirm(null);
    setDeletePinError(null);
  };
  const confirmDeleteWithPin = async () => {
    if (!deleteConfirm || !firebaseRefs) return;
    const { kid, pinDraft } = deleteConfirm;
    if (!pinDraft || pinDraft.length < 4) {
      setDeletePinError('Enter at least 4 digits');
      return;
    }
    try {
      const pinSnap = await getDoc(doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'pins', pinDraft));
      if (!pinSnap.exists()) {
        setDeletePinError('Invalid PIN');
        return;
      }
      if (pinSnap.data().hubKey !== activeProfile.hubKey) {
        setDeletePinError('PIN does not belong to this profile');
        return;
      }
      await deleteDoc(getHubRef('kids', kid.id));
      showToast('Kid deleted', 'success');
      cancelConfirmDelete();
    } catch (e) {
      console.error('Delete failed:', e);
      showToast('Delete failed', 'error');
    }
  };

  // ─── Daily notes (ECA / Test / To-bring / Reminder) ──────────────────────
  const openNoteSheet = (kidId) => {
    const cur = dailyNotes[kidId] || {};
    const sheetKid = kids.find(k => k.id === kidId);
    const autoEcas = sheetKid ? getECAsForDate(sheetKid, selectedDate) : [];
    const autoEcaText = formatECAList(autoEcas);
    // note.eca stores MANUAL custom note only (auto comes from kid profile).
    // Legacy data may have note.eca == autoEcaText exactly (from older version) — treat as no manual override.
    let manualEca = '';
    if (cur.eca && cur.eca.trim() && cur.eca !== autoEcaText) manualEca = cur.eca;
    setSheetDraft({
      uniform: cur.uniform || '',
      eca: manualEca,
      test: cur.test || '',
      to_bring: cur.to_bring || '',
      reminder: cur.reminder || '',
    });
    setEditingNoteKidId(kidId);
  };

  const closeNoteSheet = () => {
    setEditingNoteKidId(null);
    setSheetDraft(null);
    setConfirmClearAll(false);
  };

  const saveNoteSheet = async () => {
    if (!editingNoteKidId || !sheetDraft || !firebaseRefs) return;
    const { db } = firebaseRefs;
    const ref = doc(db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids', editingNoteKidId, 'daily-notes', selectedDate);
    // sheetDraft.eca is the MANUAL custom note only (auto comes from kid profile)
    const cleaned = {
      uniform: (sheetDraft.uniform || '').trim(),
      eca: (sheetDraft.eca || '').trim(),
      test: (sheetDraft.test || '').trim(),
      to_bring: (sheetDraft.to_bring || '').trim(),
      reminder: (sheetDraft.reminder || '').trim(),
      updatedAt: Date.now(),
    };
    const isEmpty = !cleaned.uniform && !cleaned.eca && !cleaned.test && !cleaned.to_bring && !cleaned.reminder;
    try {
      if (isEmpty) {
        await deleteDoc(ref);
      } else {
        await setDoc(ref, cleaned, { merge: true });
      }
      showToast('Saved', 'success');
      closeNoteSheet();
    } catch (e) {
      console.error('Save note failed:', e);
      showToast('Save failed', 'error');
    }
  };

  const clearAllDraftFields = () => {
    setSheetDraft({ uniform: '', eca: '', test: '', to_bring: '', reminder: '' });
  };

  // Confirm-modal flow for "Clear all" button on day sheet
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const askClearAll = () => setConfirmClearAll(true);
  const cancelClearAll = () => setConfirmClearAll(false);
  const confirmClearAllAndDelete = async () => {
    if (!editingNoteKidId || !firebaseRefs) { setConfirmClearAll(false); return; }
    const { db } = firebaseRefs;
    const ref = doc(db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids', editingNoteKidId, 'daily-notes', selectedDate);
    const sheetKid = kids.find(k => k.id === editingNoteKidId);
    const autoEcas = sheetKid ? getECAsForDate(sheetKid, selectedDate) : [];
    const hasAutoEca = autoEcas.length > 0;
    try {
      if (hasAutoEca) {
        // Preserve auto-ECA: clear other fields, keep eca empty so auto shows on Schedule
        await setDoc(ref, {
          uniform: '',
          eca: '',
          test: '',
          to_bring: '',
          reminder: '',
          updatedAt: Date.now(),
        }, { merge: true });
        showToast(`All cleared (auto-ECA preserved: ${autoEcas.map(e => e.name).join(', ')})`, 'success');
      } else {
        // No auto-ECA — full delete (since sheetDraft.eca is empty)
        await deleteDoc(ref);
        showToast('All fields cleared', 'success');
      }
      setConfirmClearAll(false);
      closeNoteSheet();
    } catch (e) {
      console.error('Clear all failed:', e);
      showToast('Clear failed', 'error');
      setConfirmClearAll(false);
    }
  };

  // Resume auto reminder: clear the user override field on daily-notes, so auto bulk reminder shows again
  const resumeAutoReminder = async () => {
    if (!editingNoteKidId || !firebaseRefs) return;
    const { db } = firebaseRefs;
    const ref = doc(db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'kids', editingNoteKidId, 'daily-notes', selectedDate);
    try {
      // Use deleteField() to drop reminder but keep other fields (uniform, eca, test, to_bring)
      await updateDoc(ref, {
        reminder: deleteField(),
        updatedAt: Date.now(),
      });
      setSheetDraft(prev => ({ ...prev, reminder: '' }));
      showToast('Resumed auto reminder', 'success');
    } catch (e) {
      // If doc doesn't exist yet (no daily-notes), updateDoc throws — fallback to no-op success
      if (e?.code === 'not-found' || /No document/i.test(e?.message || '')) {
        setSheetDraft(prev => ({ ...prev, reminder: '' }));
        showToast('Resumed auto reminder', 'success');
        return;
      }
      console.error('Resume auto reminder failed:', e);
      showToast('Resume failed', 'error');
    }
  };

  const handleFullLogin = () => {
    const p = inputPhone.replace(/\D/g, '');
    const n = inputProfileName.trim();
    if (p.length < 5) { setLoginError('Phone must be at least 5 digits'); return; }
    if (!n) { setLoginError('Please enter your name'); return; }
    const prof = { hubKey: `${p}_${n.toLowerCase()}`, name: n, phone: p };
    localStorage.setItem('family_app_profile', JSON.stringify(prof));
    setActiveProfile(prof);
    setLoginError(null);
  };

  const dayNoteDebounceRef = useRef(null);
  const updateDayNote = (val, date = selectedDate) => {
    // Debounce only the Firestore write. Capture `date` at call time
    // so a date switch mid-debounce doesn't write to the wrong day.
    if (window.__dayNoteTimer) clearTimeout(window.__dayNoteTimer);
    window.__dayNoteTimer = setTimeout(async () => {
      const id = `${date}_planner`;
      await setDoc(getHubRef('meals', id), {
        date, type: 'PLANNER_NOTE', note: val, lastUpdated: Date.now()
      }, { merge: true });
    }, 500);
  };

  // General Note shown on Schedule tab (free-text agenda/journal)
  // Reuses `meals` collection with new doc key suffix to avoid a new collection listener.
  const updateGeneralNote = (val, date = selectedDate) => {
    if (window.__generalNoteTimer) clearTimeout(window.__generalNoteTimer);
    window.__generalNoteTimer = setTimeout(async () => {
      const id = `${date}_general`;
      await setDoc(getHubRef('meals', id), {
        date, type: 'GENERAL_NOTE', text: val, lastUpdated: Date.now()
      }, { merge: true });
    }, 500);
  };

  const addDishToMeal = async (type, name) => {
    if (!name || !name.trim()) {
      showToast('Enter a dish name first', 'warn');
      return;
    }
    const id = `${selectedDate}_${type}`;
    const m = (meals || []).find(x => x.id === id);
    const existing = Array.isArray(m?.dishes) ? m.dishes : [];
    if (existing.includes(name)) {
      showToast('Already added', 'warn');
      return;
    }
    await setDoc(getHubRef('meals', id), {
      date: selectedDate, type, dishes: [...existing, name], lastUpdated: Date.now()
    }, { merge: true });
    setManualInputs(prev => ({ ...prev, [type]: '' }));
    setIsLibraryOpen(false);
    showToast(`Added to ${type}`, 'success');
  };

  const removeDish = async (type, idx) => {
    const id = `${selectedDate}_${type}`;
    const m = (meals || []).find(x => x.id === id);
    if (!m || !Array.isArray(m.dishes) || !m.dishes[idx]) return;
    const dishToRemove = m.dishes[idx];
    // arrayRemove avoids race conditions when multiple devices edit concurrently
    await updateDoc(getHubRef('meals', id), { dishes: arrayRemove(dishToRemove), lastUpdated: Date.now() });
  };

  const saveMealNote = async (type) => {
    if (!editingRemark) { showToast('Open the edit panel first', 'warn'); return; }
    const id = `${selectedDate}_${type}`;
    await setDoc(getHubRef('meals', id), { remark: editingRemark.value, lastUpdated: Date.now() }, { merge: true });
    setEditingRemark(null);
    showToast('Details saved', 'success');
  };

  const handleAddGrocery = async () => {
    const val = newGrocery.trim();
    if (!val) { showToast('Enter a grocery item', 'warn'); return; }
    await addDoc(getHubRef('groceries'), { text: val, completed: false, createdAt: Date.now() });
    setNewGrocery('');
    showToast('Added to grocery', 'success');
  };

  const handleCreateCategory = async () => {
    const val = newCategoryName.trim();
    if (!val) { showToast('Enter a category name', 'warn'); return; }
    await addDoc(getHubRef('categories'), { name: val, createdAt: Date.now() });
    setNewCategoryName('');
    showToast('Already addedCategories', 'success');
  };

  const handleEditCategory = async () => {
    if (!editingCategory) { showToast('No category selected', 'warn'); return; }
    if (!editingCategoryName.trim()) { showToast('Enter a name', 'warn'); return; }
    await updateDoc(doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'categories', editingCategory), { name: editingCategoryName.trim() });
    setEditingCategory(null);
    setEditingCategoryName('');
    showToast('Category updated', 'success');
  };

  const handleDeleteCategory = async (catId) => {
    if (!window.confirm('Delete this category and all its dishes?')) return;
    // Delete all dishes in this category
    const dishesToDelete = (dishes || []).filter(d => d.categoryId === catId);
    const batch = writeBatch(firebaseRefs.db);
    dishesToDelete.forEach(d => batch.delete(doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'dishes', d.id)));
    batch.delete(doc(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'categories', catId));
    await batch.commit();
    if (currentCategoryId === catId) setCurrentCategoryId(null);
  };

  const handleAddDishToLib = async () => {
    const val = newDishName.trim();
    if (!val) { showToast('Enter a dish name', 'warn'); return; }
    if (!currentCategoryId) { showToast('Open a category first', 'warn'); return; }
    await addDoc(getHubRef('dishes'), { name: val, categoryId: currentCategoryId, createdAt: Date.now() });
    setNewDishName('');
    showToast('Dish added', 'success');
  };

  const handleExcelUpload = (e) => {
    const file = e.target.files[0];
    if (!file || !currentCategoryId) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const extractedNames = new Set();

      wb.SheetNames.forEach(sheetName => {
        const ws = wb.Sheets[sheetName];
        // Convert to 2D array [row][column]
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

        data.forEach(row => {
          row.forEach(cell => {
            if (cell != null) {
              const val = String(cell).trim();
              // Filter out single characters or empty numbers
              if (val.length > 1) extractedNames.add(val);
            }
          });
        });
      });

      // Staging: allow user to review before writing to Firestore
      setImportPendingList(
        Array.from(extractedNames).map(name => ({
          name,
          selected: true
        }))
      );
      setIsImporting(true);
    };
    reader.readAsBinaryString(file);
    e.target.value = '';
  };

  const confirmImport = async () => {
    const selected = importPendingList.filter(i => i.selected);
    if (selected.length === 0) return;
    const batch = writeBatch(firebaseRefs.db);
    selected.forEach(item => {
      const dRef = doc(collection(firebaseRefs.db, 'artifacts', appId, 'public', 'data', 'hubs', activeProfile.hubKey, 'dishes'));
      batch.set(dRef, { name: item.name, categoryId: currentCategoryId, createdAt: Date.now() });
    });
    await batch.commit();
    setImportPendingList([]);
    setIsImporting(false);
  };

  if (!isConfigReady) return (
    <div className="h-screen flex items-center justify-center bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50">
      <RefreshCw className="animate-spin text-amber-600 w-8 h-8" />
    </div>
  );

  if (!user || !activeProfile) {
    return (
      <LoginScreen
        onEmailLogin={handleEmailLogin}
        onGoogleLogin={handleGoogleLogin}
        onForgotPassword={handleForgotPassword}
        error={loginError}
        loading={loginLoading}
      />
    );
  }

  const dailyNote = (meals || []).find(m => m.id === `${selectedDate}_planner`)?.note || '';

  return (
    <div className="min-h-screen bg-slate-50 pb-32 font-sans select-none overflow-x-hidden">
      <header className="bg-white/80 backdrop-blur-md border-b sticky top-0 z-30 px-5 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-2 rounded-xl text-white shadow-md">
              <Home size={18} />
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-900 uppercase leading-none">{(hubProfile?.profile?.name || activeProfile.hubKey)} Hub</h1>
              <p className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-widest">{APP_VERSION}</p>
            </div>
          </div>
          {activeTab === 'meals' && (
            <button 
              onClick={() => { setIsLibraryOpen(true); setCurrentCategoryId(null); }} 
              className="bg-slate-900 text-white px-4 py-2 rounded-full text-xs font-bold flex items-center gap-1.5 shadow-md"
            >
              <LayoutGrid size={12} /> LIBRARY
            </button>
          )}
          {activeTab === 'schedule' && (
            <>
              <input
                type="date"
                id="__today_date_picker"
                value={selectedDate}
                onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                className="hidden"
              />
              <button 
                onClick={() => {
                  const el = document.getElementById('__today_date_picker');
                  if (!el) return;
                  if (typeof el.showPicker === 'function') el.showPicker();
                  else { el.focus(); el.click(); }
                }} 
                className="bg-slate-900 text-white p-2.5 rounded-full shadow-md hover:bg-slate-700 transition-colors"
                title="Jump to date"
              >
                <CalendarDays size={14} />
              </button>
            </>
          )}
        </div>
        {(activeTab === 'schedule' || activeTab === 'meals') && (
          <div className="flex items-center justify-between gap-2 bg-slate-100/50 p-1.5 rounded-2xl border border-slate-100">
            <button 
              onClick={() => { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d.toISOString().split('T')[0]); }} 
              className="p-2 bg-white rounded-xl shadow-sm"
            >
              <ChevronLeft size={16} />
            </button>
            <p className={`font-bold text-xs ${new Date(selectedDate).getDay() === 0 ? 'text-red-500' : 'text-slate-700'}`}>
              {new Date(selectedDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
            </p>
            <button 
              onClick={() => { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); setSelectedDate(d.toISOString().split('T')[0]); }} 
              className="p-2 bg-white rounded-xl shadow-sm"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </header>

      <main className="max-w-lg mx-auto p-4 space-y-6">
        {/* ===== SCHEDULE view ===== */}
        {activeTab === 'schedule' && (
          <div className="space-y-4">
            {/* General Note (free text agenda) */}
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-[2rem] p-6 border border-amber-100 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <StickyNote size={14} className="text-amber-600" />
                <span className="text-xs font-bold text-amber-600 uppercase tracking-widest">General Note</span>
                <span className="text-[10px] text-amber-400 ml-1">— {new Date(selectedDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              </div>
              <textarea
                key={selectedDate + '_general'}
                defaultValue={(meals || []).find(m => m.id === `${selectedDate}_general`)?.text || ''}
                className="w-full bg-transparent border-none outline-none font-bold text-sm text-amber-900 placeholder:text-amber-300 resize-none leading-relaxed"
                placeholder=""
                rows={1}
                onChange={(e) => {
                  updateGeneralNote(e.target.value, selectedDate);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = el.scrollHeight + 'px';
                }}
              />
            </div>

            {kids.length === 0 && (
              <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-slate-100 text-center">
                <Baby size={32} className="mx-auto text-slate-300 mb-3" />
                <p className="font-bold text-slate-700 text-sm">No kids yet</p>
                <p className="text-xs text-slate-500 mt-2 mb-4">Add your kids to start tracking school schedules, uniforms and lunch.</p>
                <button onClick={() => openKidForm()} className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-xs font-bold uppercase shadow-lg">
                  Add Your First Kid
                </button>
              </div>
            )}

            {kids.map(kid => {
              const color = KID_COLORS.find(c => c.name === kid.color) || KID_COLORS[0];
              const noteForKid = dailyNotes[kid.id] || {};
              // Dress code display priority: manual override (daily-note.uniform) > ECA dress_code override > auto from schedule
              const uniformAuto = computeUniformForDate(kid, selectedDate);
              // Find ECAs on this date with non-not_specified dress_code (override source)
              const autoEcas = getECAsForDate(kid, selectedDate);
              const ecaOverride = autoEcas.find(e => e.dress_code && e.dress_code !== 'not_specified');
              const dcCap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
              const uniformToday = (noteForKid.uniform && noteForKid.uniform.trim())
                ? noteForKid.uniform
                : ecaOverride
                  ? dcCap(ecaOverride.dress_code)
                  : uniformAuto;
              const uniformIsManual = !!(noteForKid.uniform && noteForKid.uniform.trim()) && noteForKid.uniform.trim() !== (uniformAuto || '');
              const uniformIsEcaOverride = !uniformIsManual && !!ecaOverride;
              // Auto ECAs (reused for the ECA rows below) — uses same ecaOverride as override source
              const autoEcaText = formatECAList(autoEcas);
              const us = kid.uniform_schedule;
              let uniformHint = null;
              if (us) {
                const todayStr = selectedDate;
                const today = new Date(todayStr + 'T00:00:00');
                const dayIdx = (today.getDay() + 6) % 7;
                const isWeekend = dayIdx >= 5;
                const isHoliday = (kid.school_holidays || []).includes(todayStr);
                const isExam = (kid.exam_dates || []).includes(todayStr);
                const isSpecial = (kid.special_dates || []).includes(todayStr);
                const skipDates = getSkipDates(kid);
                if (isWeekend) uniformHint = '(Weekend)';
                else if (isHoliday) uniformHint = '(Holiday)';
                else if (isExam) uniformHint = '(Exam)';
                else if (isSpecial) uniformHint = '(Special)';
                else if (us.type === 'fixed') uniformHint = '(Weekday)';
                else if (us.type === 'cycle' && us.start_date) {
                  const start = new Date(us.start_date.slice(0, 10) + 'T00:00:00');
                  today.setHours(0,0,0,0);
                  if (today < start) uniformHint = '(Not started)';
                  else {
                    const days = countSchoolDays(start, today, skipDates);
                    const cycleLen = us.rotation_length || us.rotation?.length || 7;
                    const dayOfCycle = ((days - 1) % cycleLen + cycleLen) % cycleLen + 1;
                    uniformHint = `(Day ${dayOfCycle}/${cycleLen})`;
                  }
                }
              }
              return (
                <div key={kid.id} className={`bg-white rounded-[2rem] p-6 shadow-sm border ${color.border}`}>
                  <div className="flex items-start gap-3 mb-4">
                    <div className={`w-12 h-12 rounded-full ${color.accent} text-white flex items-center justify-center font-bold text-lg shadow-md flex-shrink-0 overflow-hidden`}>
                      {kid.avatar_data ? (
                        <img src={kid.avatar_data} alt="" className="w-full h-full object-cover" />
                      ) : (
                        null
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`font-bold text-base ${color.text} truncate`}>{kid.name}</p>
                      <p className="text-[11px] text-slate-500 font-bold uppercase tracking-wider truncate">
                        {kid.grade && `${kid.grade}`}{kid.school && ` • ${kid.school}`}
                      </p>
                    </div>
                    {/* DRESS CODE pill — top-right */}
                    <button
                      onClick={() => openNoteSheet(kid.id)}
                      className={`${color.bg} rounded-xl p-2 px-3 border ${color.border} flex-shrink-0 max-w-[55%] text-left active:scale-95 transition-transform`}
                    >
                      <div className="flex items-center gap-1 mb-0.5">
                        <Shirt size={12} className={color.text} />
                        <span className={`text-[9px] font-bold uppercase ${color.text}`}>Dress code</span>
                      </div>
                      <p className="text-xs font-bold text-slate-700 truncate">
                        {translateDressCode(uniformToday) || '—'}
                      </p>
                      {(() => {
                        // Always show day count when applicable — even with ECA override
                        let displayHint = null;
                        if (uniformIsEcaOverride && ecaOverride) {
                          displayHint = `ECA${uniformHint ? ` • ${uniformHint}` : ''}`;
                        } else {
                          displayHint = uniformHint;
                        }
                        return displayHint && uniformToday ? (
                          <p className="text-[8px] text-slate-400 mt-0.5 truncate">{displayHint}</p>
                        ) : null;
                      })()}
                    </button>
                  </div>

                  {/* 4 horizontal long rows: ECA / Test / To-bring / Reminder — Dress code shown as top pill above */}
                  <div className="space-y-2">
                    {(() => {
                      const note = dailyNotes[kid.id] || {};
                      const rowSpecs = [
                        { key: 'eca',      label: 'ECA',        Icon: ECAIcon },
                        { key: 'test',     label: 'Test',       Icon: GraduationCap },
                        { key: 'to_bring', label: 'To-bring',   Icon: Backpack },
                        { key: 'reminder', label: 'Reminder',   Icon: Bell },
                      ];
                      return rowSpecs.map(({ key, label, Icon }) => {
                        // ECA display: auto (from profile) + custom note (manual), joined by newline
                        let value = note[key];
                        if (key === 'eca') {
                          const manual = (note.eca || '').trim();
                          if (autoEcaText && manual) value = `${autoEcaText}\n${manual}`;
                          else if (autoEcaText) value = autoEcaText;
                          else value = manual;
                        }
                        if (key === 'reminder') {
                          const manual = (note.reminder || '').trim();
                          const autoRem = getAutoReminderText(kid.id, selectedDate);
                          // Display order: user override (if any) > auto
                          if (manual) value = manual;
                          else if (autoRem) value = autoRem;
                          else value = '';
                        }
                        const hasAuto = (key === 'eca' && !!autoEcaText) || (key === 'reminder' && !!getAutoReminderText(kid.id, selectedDate));
                        return (
                          <button
                            key={key}
                            onClick={() => openNoteSheet(kid.id)}
                            className={`${color.bg} rounded-xl p-3 border ${color.border} text-left active:scale-[0.98] transition-transform w-full`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <Icon size={14} className={color.text} />
                              <span className={`text-[10px] font-bold uppercase ${color.text}`}>{label}</span>
                              {hasAuto && (
                                <span className="text-[8px] text-slate-400 ml-auto flex items-center gap-1">
                                  <span>🔒</span><span>Auto</span>
                                </span>
                              )}
                            </div>
                            {value ? (
                              <p className="text-xs font-bold text-slate-700 truncate whitespace-pre-wrap break-words">{value}</p>
                            ) : (
                              <p className="text-xs font-bold text-slate-300">+ Tap to add</p>
                            )}
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ===== KIDS view ===== */}
        {activeTab === 'kids' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-base text-slate-800 flex items-center gap-2"><Users size={16} /> Kids</h2>
                <p className="text-[11px] text-slate-500 mt-1">{kids.length} {kids.length === 1 ? 'kid' : 'kids'}</p>
              </div>
              <button onClick={() => openKidForm()} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-xs font-bold uppercase shadow-lg flex items-center gap-1.5">
                <Plus size={14} /> Add
              </button>
            </div>

            {kids.length === 0 && (
              <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-slate-100 text-center">
                <Baby size={32} className="mx-auto text-slate-300 mb-3" />
                <p className="font-bold text-slate-700 text-sm">No kids yet</p>
                <p className="text-xs text-slate-500 mt-2">Add Your First Kid to get started.</p>
              </div>
            )}

            {kids.map(kid => {
              const color = KID_COLORS.find(c => c.name === kid.color) || KID_COLORS[0];
              return (
                <div
                  key={kid.id}
                  onClick={() => openKidForm(kid)}
                  className={`bg-white rounded-2xl p-5 shadow-sm border ${color.border} flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform`}
                >
                  <div className={`w-14 h-14 rounded-2xl ${color.accent} text-white flex items-center justify-center font-bold text-xl shadow-md overflow-hidden flex-shrink-0`}>
                    {kid.avatar_data ? (
                      <img src={kid.avatar_data} alt="" className="w-full h-full object-cover" />
                    ) : (
                      null
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`font-bold text-base ${color.text}`}>{kid.name}</p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {[kid.grade, kid.className, kid.school].filter(Boolean).join(' • ') || 'No school info yet'}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); openConfirmDelete(kid); }}
                    className="p-2 text-slate-200 hover:text-red-500 rounded-lg flex-shrink-0"
                    title="Delete kid"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* ===== Kid form modal ===== */}
        {showKidForm && (
          <div className="fixed inset-0 bg-slate-900/50 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowKidForm(false)}>
            <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-lg p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-base text-slate-800">{editingKidId ? 'Edit Kid' : 'Add Kid'}</h3>
                <button onClick={() => setShowKidForm(false)} className="p-2 text-slate-300 hover:text-slate-600 rounded-lg">
                  <X size={20} />
                </button>
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Name</label>
                <input
                  type="text"
                  value={kidForm.name}
                  onChange={(e) => setKidForm(prev => ({ ...prev, name: e.target.value, avatar: prev.avatar || e.target.value.charAt(0).toUpperCase() }))}
                  className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1"
                  placeholder="e.g. Jacob"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Avatar</label>
                <div className="flex items-center gap-3 mt-1">
                  {(() => {
                    const previewColor = KID_COLORS.find(c => c.name === kidForm.color) || KID_COLORS[0];
                    return (
                      <div className={`w-14 h-14 rounded-2xl ${previewColor.accent} text-white flex items-center justify-center font-bold text-xl shadow-md overflow-hidden flex-shrink-0`}>
                        {kidForm.avatar_data ? (
                          <img src={kidForm.avatar_data} alt="" className="w-full h-full object-cover" />
                        ) : (
                          null
                        )}
                      </div>
                    );
                  })()}
                  <input
                    type="file"
                    id="__kid_avatar_picker"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 500 * 1024) {
                        showToast('Image too large (max 500KB)', 'warn');
                        e.target.value = '';
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = (ev) => setKidForm(prev => ({ ...prev, avatar_data: ev.target.result }));
                      reader.readAsDataURL(file);
                      e.target.value = '';
                    }}
                  />
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => document.getElementById('__kid_avatar_picker')?.click()}
                      className="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 shadow"
                    >
                      <PencilLine size={12} /> Upload
                    </button>
                    {kidForm.avatar_data && (
                      <button
                        type="button"
                        onClick={() => setKidForm(prev => ({ ...prev, avatar_data: '' }))}
                        className="text-slate-400 hover:text-red-500 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1"
                      >
                        <X size={11} /> Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">School</label>
                <input
                  type="text"
                  value={kidForm.school}
                  onChange={(e) => setKidForm(prev => ({ ...prev, school: e.target.value }))}
                  className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1"
                  placeholder="e.g. St. Mary's Primary"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Grade</label>
                  <select
                    value={kidForm.grade}
                    onChange={(e) => setKidForm(prev => ({ ...prev, grade: e.target.value }))}
                    className="w-full bg-slate-50 px-2 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1"
                  >
                    <option value="">—</option>
                    {KID_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Class</label>
                  <input
                    type="text"
                    value={kidForm.className}
                    onChange={(e) => setKidForm(prev => ({ ...prev, className: e.target.value }))}
                    className="w-full bg-slate-50 px-2 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1"
                    placeholder="2B"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Student&nbsp;#</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={kidForm.student_no}
                    onChange={(e) => setKidForm(prev => ({ ...prev, student_no: e.target.value }))}
                    className="w-full bg-slate-50 px-2 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1"
                    placeholder="21"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">School phone</label>
                <input
                  type="tel"
                  value={kidForm.school_phone}
                  onChange={(e) => setKidForm(prev => ({ ...prev, school_phone: e.target.value }))}
                  className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1"
                  placeholder="2345 6789"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Color</label>
                <div className="flex gap-2 mt-2">
                  {KID_COLORS.map(c => (
                    <button
                      key={c.name}
                      onClick={() => setKidForm(prev => ({ ...prev, color: c.name }))}
                      className={`w-10 h-10 rounded-full ${c.accent} ${kidForm.color === c.name ? 'ring-4 ring-offset-2 ring-slate-300' : ''}`}
                    />
                  ))}
                </div>
              </div>

              {/* ── Date picker sections (3 separate fields, same component) ────────────────────────── */}
              <DatePickerSection
                field="school_holidays"
                title="School Holidays"
                hint="Auto-skip Sat/Sun. Add other non-attendance days here (e.g. Christmas, typhoon)."
                IconComp={CalendarDays}
                kidForm={kidForm}
                setKidForm={setKidForm}
                showToast={showToast}
              />
              <DatePickerSection
                field="exam_dates"
                title="Exam Schedule"
                hint="Exam days advance the N-day cycle (skipped). E.g. mid-terms, finals, weekly quizzes."
                IconComp={GraduationCap}
                kidForm={kidForm}
                setKidForm={setKidForm}
                showToast={showToast}
              />
              <DatePickerSection
                field="special_dates"
                title="Special Days"
                hint="Special activity days advance the N-day cycle (skipped). E.g. swimming day, picnic, visitor day."
                IconComp={Sparkles}
                kidForm={kidForm}
                setKidForm={setKidForm}
                showToast={showToast}
              />

              {/* ── Uniform Schedule ───────────────────────────────────────── */}
              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                    <Shirt size={12} /> Dress Code Schedule
                  </label>
                </div>

                {/* Tabs */}
                <div className="grid grid-cols-2 gap-1 bg-slate-100 p-1 rounded-xl mb-3">
                  <button
                    type="button"
                    onClick={() => setKidForm(prev => ({ ...prev, uniform_schedule: { ...prev.uniform_schedule, type: 'fixed' } }))}
                    className={`py-2 rounded-lg text-xs font-bold uppercase transition-all ${(kidForm.uniform_schedule?.type || 'fixed') === 'fixed' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
                  >
                    Fixed Weekday
                  </button>
                  <button
                    type="button"
                    onClick={() => setKidForm(prev => ({ ...prev, uniform_schedule: { ...prev.uniform_schedule, type: 'cycle' } }))}
                    className={`py-2 rounded-lg text-xs font-bold uppercase transition-all ${kidForm.uniform_schedule?.type === 'cycle' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
                  >
                    Cycle (N days)
                  </button>
                </div>

                {/* Fixed mode */}
                {(kidForm.uniform_schedule?.type || 'fixed') === 'fixed' && (
                  <div className="space-y-2">
                    {['mon','tue','wed','thu','fri'].map(d => (
                      <div key={d} className="flex items-center gap-2">
                        <span className="w-12 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{WEEKDAY_LABELS[d]}</span>
                        <select
                          value={kidForm.uniform_schedule?.weekday_map?.[d] || 'Uniform'}
                          onChange={(e) => setKidForm(prev => ({
                            ...prev,
                            uniform_schedule: {
                              ...prev.uniform_schedule,
                              weekday_map: { ...(prev.uniform_schedule?.weekday_map || {}), [d]: e.target.value }
                            }
                          }))}
                          className="flex-1 bg-slate-50 px-3 py-2 rounded-lg font-bold outline-none border border-slate-100 text-sm"
                        >
                          {UNIFORM_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                )}

                {/* Cycle mode */}
                {kidForm.uniform_schedule?.type === 'cycle' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex-shrink-0">Day 1 starts</span>
                      <input
                        type="date"
                        value={kidForm.uniform_schedule?.start_date || ''}
                        onChange={(e) => setKidForm(prev => ({ ...prev, uniform_schedule: { ...prev.uniform_schedule, start_date: e.target.value } }))}
                        className="flex-1 bg-slate-50 px-3 py-2 rounded-lg font-bold outline-none border border-slate-100 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex-shrink-0">Cycle (N days)</span>
                      <input
                        key={`cycle_days_${editingKidId || 'new'}`}
                        type="number"
                        min="1"
                        max="14"
                        defaultValue={kidForm.uniform_schedule?.rotation_length || kidForm.uniform_schedule?.rotation?.length || 7}
                        onBlur={(e) => {
                          const newLen = Math.max(1, Math.min(14, parseInt(e.target.value) || 7));
                          const curRot = kidForm.uniform_schedule?.rotation || [];
                          const curLen = curRot.length || 7;
                          let newRot;
                          if (newLen > curLen) {
                            newRot = [...curRot];
                            for (let i = curLen; i < newLen; i++) newRot.push({ day: i + 1, uniform: 'Uniform', note: '' });
                          } else {
                            newRot = curRot.slice(0, newLen).map((r, i) => ({ ...r, day: i + 1 }));
                          }
                          setKidForm(prev => ({
                            ...prev,
                            uniform_schedule: {
                              ...prev.uniform_schedule,
                              rotation_length: newLen,
                              rotation: newRot,
                            }
                          }));
                        }}
                        className="w-20 bg-slate-50 px-3 py-2 rounded-lg font-bold outline-none border border-slate-100 text-sm"
                      />
                      <span className="text-[10px] text-slate-400">days</span>
                    </div>
                    {(kidForm.uniform_schedule?.rotation || []).map((entry, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="w-12 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Day {entry.day}</span>
                        <select
                          value={entry.uniform}
                          onChange={(e) => {
                            const newRot = [...(kidForm.uniform_schedule?.rotation || [])];
                            newRot[idx] = { ...newRot[idx], uniform: e.target.value };
                            setKidForm(prev => ({ ...prev, uniform_schedule: { ...prev.uniform_schedule, rotation: newRot } }));
                          }}
                          className="bg-slate-50 px-2 py-2 rounded-lg font-bold outline-none border border-slate-100 text-sm"
                        >
                          {UNIFORM_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <input
                          type="text"
                          placeholder="Note"
                          value={entry.note || ''}
                          onChange={(e) => {
                            const newRot = [...(kidForm.uniform_schedule?.rotation || [])];
                            newRot[idx] = { ...newRot[idx], note: e.target.value };
                            setKidForm(prev => ({ ...prev, uniform_schedule: { ...prev.uniform_schedule, rotation: newRot } }));
                          }}
                          className="flex-1 bg-slate-50 px-3 py-2 rounded-lg font-bold outline-none border border-slate-100 text-sm min-w-0"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Recurring ECAs ─────────────────────────────────── */}
              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                    <ECAIcon size={12} /> Recurring ECAs
                  </label>
                </div>
                <p className="text-[10px] text-slate-400 mb-2">e.g. Piano Mon 16:00, Swimming 15th monthly</p>

                {(kidForm.eca_recurring || []).map((eca, idx) => {
                  const keys = ['sun','mon','tue','wed','thu','fri','sat'];
                  const labels = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
                  return (
                    <div key={idx} className="bg-slate-50 rounded-xl p-3 mb-2 border border-slate-100">
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="text"
                          placeholder="ECA name (e.g. Piano)"
                          value={eca.name || ''}
                          onChange={(e) => updateEcaRow(idx, { ...eca, name: e.target.value })}
                          className="flex-1 bg-white px-3 py-2 rounded-lg font-bold outline-none border border-slate-100 text-sm"
                        />
                        <button type="button" onClick={() => askRemoveEcaRow(idx)} className="text-slate-300 hover:text-red-500 p-1" title="Delete this ECA">
                          <X size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest shrink-0 w-20">Dress code</label>
                        <select
                          value={eca.dress_code || 'not_specified'}
                          onChange={(e) => updateEcaRow(idx, { ...eca, dress_code: e.target.value })}
                          className="flex-1 bg-white px-2 py-1.5 rounded-lg font-bold outline-none border border-slate-100 text-xs"
                        >
                          <option value="not_specified">Not specified</option>
                          <option value="uniform">Uniform</option>
                          <option value="sportswear">Sportswear</option>
                          <option value="casual">Casual</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <div>
                          <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Start time</label>
                          <input type="time" value={eca.start_time || ''} onChange={(e) => updateEcaRow(idx, { ...eca, start_time: e.target.value })} className="w-full bg-white px-2 py-1.5 rounded-lg font-bold outline-none border border-slate-100 text-xs" />
                        </div>
                        <div>
                          <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">End time</label>
                          <input type="time" value={eca.end_time || ''} onChange={(e) => updateEcaRow(idx, { ...eca, end_time: e.target.value })} className="w-full bg-white px-2 py-1.5 rounded-lg font-bold outline-none border border-slate-100 text-xs" />
                        </div>
                      </div>

                      {/* Class dates picker */}
                      <div className="mt-2 pt-2 border-t border-slate-200">
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                            Class dates ({(eca.dates || []).length})
                          </label>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSkipCalIdx(null);
                                setExpandedEcaDates(new Set());
                                showToast(`Saved ${(eca.dates || []).length} date(s) for "${eca.name}"`, 'success');
                              }}
                              className="text-[9px] font-bold text-indigo-500 uppercase tracking-widest hover:text-indigo-700"
                            >
                              Save
                            </button>
                            {(eca.dates || []).length > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm(`Clear all ${eca.dates.length} dates for "${eca.name}"?`)) {
                                    updateEcaRow(idx, { ...eca, dates: [] });
                                    showToast('Cleared all dates', 'success');
                                  }
                                }}
                                className="text-[9px] font-bold text-red-400 uppercase tracking-widest hover:text-red-600"
                              >
                                Clear all
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mb-1">
                          <button
                            type="button"
                            onClick={() => {
                              const isOpen = skipCalIdx === idx;
                              if (isOpen) { setSkipCalIdx(null); return; }
                              const seed = eca.dates?.[0] || new Date().toISOString().slice(0, 10);
                              const d = new Date(seed + 'T00:00:00');
                              setSkipCalIdx(idx);
                              setSkipCalView({ y: d.getFullYear(), m: d.getMonth() });
                              setSkipCalRange({ from: '', to: '' });
                            }}
                            className={`flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold uppercase ${skipCalIdx === idx ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 border border-slate-200'}`}
                          >
                            {skipCalIdx === idx ? 'Close calendar' : '📅 Pick dates'}
                          </button>
                        </div>

                        {/* ─── Calendar multi-select (toggle dates directly) ─────────────────────────────── */}
                        {skipCalIdx === idx && (() => {
                          const view = skipCalView;
                          const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                          const firstOfMonth = new Date(view.y, view.m, 1);
                          const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
                          const firstDow = firstOfMonth.getDay();
                          const cells = [];
                          for (let i = 0; i < firstDow; i++) cells.push(null);
                          for (let dom = 1; dom <= daysInMonth; dom++) {
                            const d = new Date(view.y, view.m, dom);
                            const ds = ymd(view.y, view.m, dom);
                            const dowKey = WEEKDAY_KEYS_FULL[d.getDay()];
                            cells.push({ ds, dom, d, dowKey });
                          }
                          const datesSet = new Set(eca.dates || []);
                          function toggleDate(ds) {
                            const cur = eca.dates || [];
                            const next = cur.includes(ds) ? cur.filter(x => x !== ds) : [...cur, ds].sort();
                            updateEcaRow(idx, { ...eca, dates: next });
                          }
                          // Bulk range — add all dates in range (no weekday filter)
                          function addRange() {
                            if (!skipCalRange.from || !skipCalRange.to) { showToast('Pick range dates first', 'warn'); return; }
                            if (skipCalRange.from > skipCalRange.to) { showToast('From must be before To', 'warn'); return; }
                            const [fy, fm, fd] = skipCalRange.from.split('-').map(Number);
                            const [ey, em, ed] = skipCalRange.to.split('-').map(Number);
                            const added = [];
                            for (let d = new Date(fy, fm - 1, fd); d <= new Date(ey, em - 1, ed); d.setDate(d.getDate() + 1)) {
                              added.push(ymd(d.getFullYear(), d.getMonth(), d.getDate()));
                            }
                            if (!added.length) { showToast('No dates in range', 'warn'); return; }
                            const merged = Array.from(new Set([...(eca.dates || []), ...added])).sort();
                            updateEcaRow(idx, { ...eca, dates: merged });
                            showToast(`Added ${added.length} date(s)`, 'success');
                            setSkipCalRange({ from: '', to: '' });
                          }
                          // Bulk range for specific weekday(s)
                          const [wdFrom, setWdFrom] = (() => {
                            const sel = skipCalRange.weekday || '';
                            return [sel, (v) => setSkipCalRange(prev => ({ ...prev, weekday: v }))];
                          })();
                          function addRangeWeekday() {
                            if (!skipCalRange.from || !skipCalRange.to) { showToast('Pick range dates first', 'warn'); return; }
                            if (!skipCalRange.weekday) { showToast('Pick a weekday', 'warn'); return; }
                            const target = skipCalRange.weekday;
                            const targetPy = WEEKDAY_KEYS_FULL.indexOf(target);
                            const [fy, fm, fd] = skipCalRange.from.split('-').map(Number);
                            const [ey, em, ed] = skipCalRange.to.split('-').map(Number);
                            const added = [];
                            for (let d = new Date(fy, fm - 1, fd); d <= new Date(ey, em - 1, ed); d.setDate(d.getDate() + 1)) {
                              if (d.getDay() === targetPy) added.push(ymd(d.getFullYear(), d.getMonth(), d.getDate()));
                            }
                            if (!added.length) { showToast(`No ${target} in range`, 'warn'); return; }
                            const merged = Array.from(new Set([...(eca.dates || []), ...added])).sort();
                            updateEcaRow(idx, { ...eca, dates: merged });
                            showToast(`Added ${added.length} ${target} date(s)`, 'success');
                          }
                          function shiftMonth(delta) {
                            let { y, m } = view;
                            m += delta;
                            if (m < 0) { m += 12; y -= 1; }
                            if (m > 11) { m -= 12; y += 1; }
                            setSkipCalView({ y, m });
                          }
                          const monthLabel = new Date(view.y, view.m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                          return (
                            <div className="mt-2 bg-white rounded-xl p-3 border border-slate-200 shadow-sm">
                              <div className="flex items-center justify-between mb-2">
                                <button type="button" onClick={() => shiftMonth(-1)} className="p-1 bg-slate-100 rounded-lg"><ChevronLeft size={14} /></button>
                                <span className="text-xs font-bold text-slate-700">{monthLabel}</span>
                                <button type="button" onClick={() => shiftMonth(1)} className="p-1 bg-slate-100 rounded-lg"><ChevronRight size={14} /></button>
                              </div>
                              <div className="grid grid-cols-7 gap-1 text-center mb-1">
                                {WEEKDAY_KEYS_FULL.map(k => (
                                  <div key={k} className={`text-[9px] font-bold uppercase ${k === 'sun' ? SUN_HEADER_CLS : 'text-slate-400'}`}>{WEEKDAY_LABELS[k]}</div>
                                ))}
                              </div>
                              <div className="grid grid-cols-7 gap-1">
                                {cells.map((c, i) => {
                                  if (!c) return <div key={'b' + i} />;
                                  const selected = datesSet.has(c.ds);
                                  const isSun = c.dowKey === 'sun';
                                  const cls = selected
                                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                    : isSun
                                      ? 'bg-slate-50 text-red-500 hover:bg-slate-200'
                                      : 'bg-slate-50 text-slate-700 hover:bg-slate-200';
                                  return (
                                    <button
                                      key={c.ds}
                                      type="button"
                                      onClick={() => toggleDate(c.ds)}
                                      className={`h-8 rounded text-[11px] font-bold ${cls}`}
                                      title={c.ds}
                                    >
                                      {c.dom}
                                    </button>
                                  );
                                })}
                              </div>

                              {/* Bulk range adders */}
                              <div className="mt-3 pt-2 border-t border-slate-100 space-y-2">
                                <div>
                                  <div className="text-[9px] font-bold text-slate-400 uppercase mb-1">Bulk: add every date in range</div>
                                  <div className="flex items-center gap-1">
                                    <input type="date" value={skipCalRange.from} onChange={(e) => setSkipCalRange(prev => ({ ...prev, from: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
                                    <span className="text-[10px] text-slate-400">to</span>
                                    <input type="date" value={skipCalRange.to} onChange={(e) => setSkipCalRange(prev => ({ ...prev, to: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
                                    <button type="button" onClick={addRange} className="bg-slate-200 text-slate-700 px-3 py-1 rounded text-[10px] font-bold uppercase whitespace-nowrap">Add</button>
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[9px] font-bold text-slate-400 uppercase mb-1">Bulk: add only one weekday in range</div>
                                  <div className="space-y-1.5">
                                    <div className="flex items-center gap-1">
                                      <input type="date" value={skipCalRange.from} onChange={(e) => setSkipCalRange(prev => ({ ...prev, from: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
                                      <span className="text-[10px] text-slate-400">to</span>
                                      <input type="date" value={skipCalRange.to} onChange={(e) => setSkipCalRange(prev => ({ ...prev, to: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <select value={skipCalRange.weekday || ''} onChange={(e) => setSkipCalRange(prev => ({ ...prev, weekday: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100">
                                        <option value="">weekday…</option>
                                        {keys.map(k => <option key={k} value={k}>{labels[k]}</option>)}
                                      </select>
                                      <button type="button" onClick={addRangeWeekday} className="bg-slate-200 text-slate-700 px-3 py-1 rounded text-[10px] font-bold uppercase whitespace-nowrap">Add</button>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-100">
                                <span className="text-[10px] font-bold text-slate-400 uppercase">
                                  {datesSet.size} date(s) selected
                                </span>
                                <button type="button" onClick={() => setSkipCalIdx(null)} className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg text-[10px] font-bold uppercase">
                                  Done
                                </button>
                              </div>
                            </div>
                          );
                        })()}

                        {(eca.dates || []).length > 0 && (() => {
                          const allDates = eca.dates || [];
                          const isExpanded = expandedEcaDates.has(idx);
                          const COLLAPSED_LIMIT = 12;
                          const visibleDates = isExpanded ? allDates : allDates.slice(0, COLLAPSED_LIMIT);
                          const hiddenCount = allDates.length - visibleDates.length;
                          return (
                            <>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {visibleDates.map(d => (
                                  <span key={d} className="bg-white px-2 py-0.5 rounded-md text-[10px] font-bold text-slate-500 flex items-center gap-1 border border-slate-100">
                                    {d}
                                    <button type="button" onClick={() => updateEcaRow(idx, { ...eca, dates: (eca.dates || []).filter(x => x !== d) })} className="text-slate-300 hover:text-red-500">
                                      <X size={10} />
                                    </button>
                                  </span>
                                ))}
                              </div>
                              {hiddenCount > 0 && (
                                <button type="button" onClick={() => toggleEcaExpand(idx)} className="mt-1 text-[10px] font-bold text-indigo-600 uppercase tracking-widest hover:text-indigo-800">
                                  Show all {allDates.length} dates ▾
                                </button>
                              )}
                              {isExpanded && allDates.length > COLLAPSED_LIMIT && (
                                <button type="button" onClick={() => toggleEcaExpand(idx)} className="mt-1 text-[10px] font-bold text-slate-400 uppercase tracking-widest hover:text-slate-600">
                                  Shrink ▴
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={addEcaRow}
                  className="w-full bg-indigo-50 text-indigo-600 py-2 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 border border-indigo-100"
                >
                  <Plus size={12} /> Add ECA
                </button>
              </div>

              {/* ── Bulk Reminders (auto reminder source) ─────────────────────────────────── */}
              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                    <Bell size={12} /> Bulk Reminders (auto)
                  </label>
                  <button
                    type="button"
                    onClick={() => openBulkReminderModal(null)}
                    disabled={!editingKidId}
                    className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    <Plus size={11} /> Add
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 mb-2 leading-snug">
                  {editingKidId
                    ? 'e.g. Buy concert ticket on concert day, Bring PE kit on PE day. User can still override per-day in Schedule tab.'
                    : 'Save kid first to enable bulk reminders.'}
                </p>

                {editingKidId && (() => {
                  // Group all (date, text) docs by text — like ECA pattern: one row per text + date chips
                  const all = Object.entries(bulkReminders[editingKidId] || {});
                  if (!all.length) {
                    return <p className="text-[10px] text-slate-300 italic py-2">No bulk reminders yet — tap "+ Add" to set up.</p>;
                  }
                  const grouped = {};
                  all.forEach(([date, text]) => {
                    if (!grouped[text]) grouped[text] = [];
                    grouped[text].push(date);
                  });
                  // Sort groups by their earliest date
                  const sortedGroups = Object.entries(grouped)
                    .sort(([, a], [, b]) => a.sort()[0].localeCompare(b.sort()[0]));
                  const COLLAPSE_DELAY = 12;
                  return (
                    <div className="space-y-2">
                      {sortedGroups.map(([text, dates]) => {
                        const sortedDates = dates.slice().sort();
                        const isExpanded = expandedBulkReminderGroups.has(text);
                        const visible = isExpanded ? sortedDates : sortedDates.slice(0, COLLAPSE_DELAY);
                        const hidden = sortedDates.length - visible.length;
                        return (
                          <div key={text} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                            <div className="flex items-start gap-2 mb-2">
                              <span className="text-sm font-bold text-slate-700 flex-1 min-w-0 break-words">{text}</span>
                              <button
                                type="button"
                                onClick={() => openBulkReminderModal({ text })}
                                className="text-slate-300 hover:text-indigo-600 p-1 shrink-0"
                                title="Edit group"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteBulkReminderGroup(text)}
                                className="text-slate-300 hover:text-red-500 p-1 shrink-0"
                                title="Delete group"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {visible.map(d => (
                                <span key={d} className="bg-white px-2 py-0.5 rounded-md text-[10px] font-bold text-slate-500 flex items-center gap-1 border border-slate-100">
                                  {d}
                                  <button
                                    type="button"
                                    onClick={() => deleteBulkReminder(d)}
                                    className="text-slate-300 hover:text-red-500"
                                    title={`Remove reminder on ${d}`}
                                  >
                                    <X size={10} />
                                  </button>
                                </span>
                              ))}
                            </div>
                            {hidden > 0 && (
                              <button
                                type="button"
                                onClick={() => toggleBulkReminderExpand(text)}
                                className="mt-1 text-[10px] font-bold text-indigo-600 uppercase tracking-widest hover:text-indigo-800"
                              >
                                Show all {sortedDates.length} dates ▾
                              </button>
                            )}
                            {isExpanded && sortedDates.length > COLLAPSE_DELAY && (
                              <button
                                type="button"
                                onClick={() => toggleBulkReminderExpand(text)}
                                className="mt-1 text-[10px] font-bold text-slate-400 uppercase tracking-widest hover:text-slate-600"
                              >
                                Shrink ▴
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              <button
                onClick={handleSaveKid}
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold uppercase text-sm shadow-lg"
              >
                {editingKidId ? 'Save Changes' : 'Add Kid'}
              </button>
            </div>
          </div>
        )}

        {/* ===== Daily-note sheet (Dress code / ECA note / Test / To-bring / Reminder) ===== */}
        {editingNoteKidId && sheetDraft && (() => {
          const sheetKid = kids.find(k => k.id === editingNoteKidId);
          if (!sheetKid) return null;
          const sheetColor = KID_COLORS.find(c => c.name === sheetKid.color) || KID_COLORS[0];
          const dateLabel = new Date(selectedDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
          const sheetAutoEcas = getECAsForDate(sheetKid, selectedDate);
          const sheetAutoEcaText = formatECAList(sheetAutoEcas);
          const sheetAutoReminder = getAutoReminderText(editingNoteKidId, selectedDate);
          const fields = [
            { key: 'uniform',  label: 'Dress code',  Icon: Shirt,         placeholder: 'e.g. Sportswear (override today)' },
            { key: 'eca',      label: 'ECA note', Icon: ECAIcon,        placeholder: 'e.g. Piano 4pm' },
            { key: 'test',     label: 'Test',     Icon: GraduationCap, placeholder: 'e.g. Math quiz ch3' },
            { key: 'to_bring', label: 'To-bring',     Icon: Backpack,      placeholder: 'e.g. Water bottle + PE kit' },
          ];
          return (
            <div className="fixed inset-0 bg-slate-900/50 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={closeNoteSheet}>
              <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-lg p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-base text-slate-800 flex items-center gap-2">
                      <span className={`w-7 h-7 rounded-full ${sheetColor.accent} overflow-hidden flex-shrink-0`} />
                      {sheetKid.name}'s Day
                    </h3>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">{dateLabel}</p>
                  </div>
                  <button onClick={closeNoteSheet} className="p-2 text-slate-300 hover:text-slate-600 rounded-lg">
                    <X size={20} />
                  </button>
                </div>

                {/* Uniform / Test / To-bring — simple textareas */}
                {fields.filter(f => f.key !== 'eca').map(({ key, label, Icon: FieldIcon, placeholder }) => (
                  <div key={key}>
                    <label className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 ${sheetColor.text}`}>
                      <FieldIcon size={12} /> {label}
                    </label>
                    <textarea
                      value={sheetDraft[key] || ''}
                      onChange={(e) => setSheetDraft(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      rows={2}
                      className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1 text-sm resize-none"
                    />
                  </div>
                ))}

                {/* Reminder — Auto (read-only, if any) + manual override + Resume */}
                <div>
                  <label className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 ${sheetColor.text}`}>
                    <Bell size={12} /> Reminder
                    {sheetAutoReminder && (
                      <span className="ml-auto text-[9px] font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md normal-case tracking-normal flex items-center gap-1">
                        <span>🔒</span><span>Auto from profile</span>
                      </span>
                    )}
                  </label>
                  {sheetAutoReminder && (
                    <div className="mt-1 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm font-bold text-amber-900 whitespace-pre-wrap break-words">
                      {sheetAutoReminder}
                    </div>
                  )}
                  <label className="block text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-2">
                    Reminder note (manual override, optional)
                  </label>
                  <textarea
                    value={sheetDraft.reminder || ''}
                    onChange={(e) => setSheetDraft(prev => ({ ...prev, reminder: e.target.value }))}
                    placeholder="e.g. Leave 10 min early"
                    rows={2}
                    className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1 text-sm resize-none"
                  />
                  {sheetAutoReminder && (sheetDraft.reminder || '').trim() && (
                    <button
                      type="button"
                      onClick={resumeAutoReminder}
                      className="mt-2 w-full bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-1.5"
                    >
                      <RefreshCw size={12} /> Resume auto reminder
                    </button>
                  )}
                  <p className="text-[10px] text-slate-400 mt-1 leading-snug">
                    {sheetAutoReminder
                      ? <>Auto from kid profile stays unless you write a manual override. Click <strong>Resume</strong> above to clear your note and let auto show again.</>
                      : <>No auto reminder from kid profile for today. Add your own here.</>}
                  </p>
                </div>

                {/* ECA — Auto (read-only, if any) + Note (manual override) */}
                <div>
                  <label className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 ${sheetColor.text}`}>
                    <ECAIcon size={12} /> ECA
                    {sheetAutoEcaText && (
                      <span className="ml-auto text-[9px] font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md normal-case tracking-normal flex items-center gap-1">
                        <span>🔒</span><span>Auto from profile</span>
                      </span>
                    )}
                  </label>
                  {sheetAutoEcaText && (
                    <div className="mt-1 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm font-bold text-amber-900 whitespace-pre-wrap break-words">
                      {sheetAutoEcaText}
                    </div>
                  )}
                  <label className="block text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-2">
                    ECA note (manual override, optional)
                  </label>
                  <textarea
                    value={sheetDraft.eca || ''}
                    onChange={(e) => setSheetDraft(prev => ({ ...prev, eca: e.target.value }))}
                    placeholder="e.g. bring racket, leave 10 min early"
                    rows={2}
                    className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1 text-sm resize-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-snug">
                    {sheetAutoEcaText
                      ? <>Auto from kid profile stays regardless of this note. To remove the ECA, edit the kid's profile.</>
                      : <>No ECA scheduled from kid profile for today. Add your own here.</>}
                  </p>
                </div>

                <button
                  onClick={askClearAll}
                  className="w-full text-slate-400 hover:text-red-500 py-2 text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-1.5"
                >
                  <Trash2 size={12} /> Clear all
                </button>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                  <button
                    onClick={closeNoteSheet}
                    className="bg-slate-100 text-slate-600 py-3 rounded-xl font-bold uppercase text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveNoteSheet}
                    className="bg-indigo-600 text-white py-3 rounded-xl font-bold uppercase text-sm shadow-lg"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ===== Bulk Reminder modal (Kid profile edit panel) ===== */}
        {bulkReminderModal && (() => {
          const modalKid = kids.find(k => k.id === bulkReminderModal.kidId);
          if (!modalKid) return null;
          const modalColor = KID_COLORS.find(c => c.name === modalKid.color) || KID_COLORS[0];
          const isEdit = bulkReminderModal.mode === 'edit';
          const view = bulkReminderCalView;
          const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const firstOfMonth = new Date(view.y, view.m, 1);
          const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
          const firstDow = firstOfMonth.getDay();
          const cells = [];
          for (let i = 0; i < firstDow; i++) cells.push(null);
          for (let dom = 1; dom <= daysInMonth; dom++) {
            const d = new Date(view.y, view.m, dom);
            const dowKey = WEEKDAY_KEYS_FULL[d.getDay()];
            cells.push({ ds: ymd(view.y, view.m, dom), dom, dowKey });
          }
          const datesSet = bulkReminderModal.dates;
          const monthLabel = new Date(view.y, view.m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
          function shiftMonth(delta) {
            let { y, m } = view;
            m += delta;
            if (m < 0) { m += 12; y -= 1; }
            if (m > 11) { m -= 12; y += 1; }
            setBulkReminderCalView({ y, m });
          }
          return (
            <div className="fixed inset-0 bg-slate-900/60 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={closeBulkReminderModal}>
              <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-lg p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-base text-slate-800 flex items-center gap-2">
                      <Bell size={16} className={modalColor.text} />
                      {isEdit ? 'Edit bulk reminder' : 'Add bulk reminder'}
                    </h3>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">
                      {modalKid.name} • auto reminder source
                    </p>
                  </div>
                  <button onClick={closeBulkReminderModal} className="p-2 text-slate-300 hover:text-slate-600 rounded-lg">
                    <X size={20} />
                  </button>
                </div>

                {/* Calendar multi-select — always shown so edit can add/remove dates */}
                <div className="bg-white rounded-xl p-3 border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <button type="button" onClick={() => shiftMonth(-1)} className="p-1 bg-slate-100 rounded-lg"><ChevronLeft size={14} /></button>
                    <span className="text-xs font-bold text-slate-700">{monthLabel}</span>
                    <button type="button" onClick={() => shiftMonth(1)} className="p-1 bg-slate-100 rounded-lg"><ChevronRight size={14} /></button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center mb-1">
                    {WEEKDAY_KEYS_FULL.map(k => (
                      <div key={k} className={`text-[9px] font-bold uppercase ${k === 'sun' ? SUN_HEADER_CLS : 'text-slate-400'}`}>{WEEKDAY_LABELS[k]}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {cells.map((c, i) => {
                      if (!c) return <div key={'b' + i} />;
                      const selected = datesSet.has(c.ds);
                      const isSun = c.dowKey === 'sun';
                      return (
                        <button
                          key={c.ds}
                          type="button"
                          onClick={() => toggleBulkReminderDate(c.ds)}
                          className={`h-8 rounded text-[11px] font-bold ${selected ? 'bg-indigo-600 text-white hover:bg-indigo-700' : isSun ? 'bg-slate-50 text-red-500 hover:bg-slate-200' : 'bg-slate-50 text-slate-700 hover:bg-slate-200'}`}
                          title={c.ds}
                        >
                          {c.dom}
                        </button>
                      );
                    })}
                  </div>

                  {/* Bulk range adder */}
                  <div className="mt-3 pt-2 border-t border-slate-100 space-y-2">
                    <div>
                      <div className="text-[9px] font-bold text-slate-400 uppercase mb-1">Bulk: add every date in range</div>
                      <div className="flex items-center gap-1">
                        <input type="date" value={bulkReminderCalRange.from} onChange={(e) => setBulkReminderCalRange(prev => ({ ...prev, from: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
                        <span className="text-[10px] text-slate-400">to</span>
                        <input type="date" value={bulkReminderCalRange.to} onChange={(e) => setBulkReminderCalRange(prev => ({ ...prev, to: e.target.value }))} className="flex-1 min-w-0 bg-slate-50 px-2 py-1 rounded text-xs font-bold border border-slate-100" />
                        <button type="button" onClick={addBulkReminderRange} className="bg-slate-200 text-slate-700 px-3 py-1 rounded text-[10px] font-bold uppercase whitespace-nowrap">Add</button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase">
                      {datesSet.size} date(s) selected
                    </span>
                    {datesSet.size > 0 && (
                      <button type="button" onClick={() => setBulkReminderModal(prev => ({ ...prev, dates: new Set() }))} className="text-[10px] font-bold text-red-400 uppercase tracking-widest hover:text-red-600">
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Reminder text */}
                <div>
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Reminder text</label>
                  <textarea
                    value={bulkReminderModal.text}
                    onChange={(e) => setBulkReminderModal(prev => ({ ...prev, text: e.target.value }))}
                    placeholder="e.g. Bring concert ticket + ID"
                    rows={2}
                    autoFocus={!isEdit}
                    className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold outline-none border border-slate-100 mt-1 text-sm resize-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-snug">
                    Applies to all {datesSet.size} date(s) above. User can still override per-day in Schedule tab.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                  <button
                    onClick={closeBulkReminderModal}
                    className="bg-slate-100 text-slate-600 py-3 rounded-xl font-bold uppercase text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveBulkReminderModal}
                    className="bg-indigo-600 text-white py-3 rounded-xl font-bold uppercase text-sm shadow-lg"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ===== Confirm Clear All modal ===== */}
        {confirmClearAll && editingNoteKidId && (() => {
          const clrKid = kids.find(k => k.id === editingNoteKidId);
          if (!clrKid) return null;
          const clrColor = KID_COLORS.find(c => c.name === clrKid.color) || KID_COLORS[0];
          return (
            <div className="fixed inset-0 bg-slate-900/60 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={cancelClearAll}>
              <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-2xl ${clrColor.accent} text-white flex items-center justify-center font-bold text-xl shadow-md overflow-hidden flex-shrink-0`}>
                    {clrKid.avatar_data ? (
                      <img src={clrKid.avatar_data} alt="" className="w-full h-full object-cover" />
                    ) : (
                      null
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-base text-slate-800">Clear all fields?</h3>
                    <p className="text-[11px] text-slate-500">{clrKid.name} · {new Date(selectedDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</p>
                  </div>
                </div>
                <p className="text-xs text-slate-600">Delete all 4 fields for this day. Confirm?</p>
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                  <button onClick={cancelClearAll} className="bg-slate-100 text-slate-600 py-3 rounded-xl font-bold uppercase text-sm">
                    Cancel
                  </button>
                  <button onClick={confirmClearAllAndDelete} className="bg-red-500 text-white py-3 rounded-xl font-bold uppercase text-sm shadow-lg">
                    Clear all
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ===== PIN-confirmed delete modal ===== */}
        {deleteConfirm && (() => {
          const dKid = deleteConfirm.kid;
          const dColor = KID_COLORS.find(c => c.name === dKid.color) || KID_COLORS[0];
          return (
            <div className="fixed inset-0 bg-slate-900/60 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={cancelConfirmDelete}>
              <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-2xl ${dColor.accent} text-white flex items-center justify-center font-bold text-xl shadow-md overflow-hidden flex-shrink-0`}>
                    {dKid.avatar_data ? (
                      <img src={dKid.avatar_data} alt="" className="w-full h-full object-cover" />
                    ) : (
                      null
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-base text-slate-800">Delete {dKid.name}?</h3>
                    <p className="text-[11px] text-slate-500">School info will be removed.</p>
                  </div>
                </div>
                <p className="text-xs text-slate-600">Enter login PIN to confirm delete.</p>
                <input
                  type="password"
                  inputMode="numeric"
                  value={deleteConfirm.pinDraft}
                  onChange={(e) => {
                    setDeleteConfirm(prev => ({ ...prev, pinDraft: e.target.value.replace(/\D/g, '').slice(0, 8) }));
                    setDeletePinError(null);
                  }}
                  placeholder="● ● ● ●"
                  className="w-full bg-slate-50 px-4 py-3 rounded-xl font-bold text-center text-2xl tracking-[0.5em] outline-none border border-slate-100"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && confirmDeleteWithPin()}
                />
                {deletePinError && <p className="text-xs text-red-500 font-bold text-center">{deletePinError}</p>}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                  <button onClick={cancelConfirmDelete} className="bg-slate-100 text-slate-600 py-3 rounded-xl font-bold uppercase text-sm">
                    Cancel
                  </button>
                  <button onClick={confirmDeleteWithPin} className="bg-red-500 text-white py-3 rounded-xl font-bold uppercase text-sm shadow-lg">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {confirmKidSave && (() => {
          const allChanges = confirmKidSave.diff;
          const groups = [
            { key: 'Profile',  label: '👤 Profile',  subtitle: 'Name, school, class info' },
            { key: 'Schedule', label: '📅 Schedule', subtitle: 'Uniform cycle + skip days' },
            { key: 'ECAs',     label: '🏓 ECAs',     subtitle: 'Recurring activities' },
          ];
          const grouped = groups.map(g => ({
            ...g,
            changes: allChanges.filter(c => c.category === g.key),
          })).filter(g => g.changes.length > 0);
          return (
            <div className="fixed inset-0 bg-slate-900/60 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setConfirmKidSave(null)}>
              <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 space-y-4 shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div>
                  <h3 className="font-bold text-base text-slate-800">Save changes for {confirmKidSave.payload.name}?</h3>
                  <p className="text-[11px] text-slate-500 mt-1">{allChanges.length} change(s) across {grouped.length} section(s). Review below before confirming.</p>
                </div>
                <div className="space-y-3 overflow-y-auto flex-1 bg-slate-50 rounded-xl p-3 border border-slate-100">
                  {grouped.map(g => (
                    <div key={g.key} className="bg-white rounded-xl border border-slate-100 overflow-hidden">
                      <div className="bg-slate-50 px-3 py-2 border-b border-slate-100">
                        <div className="text-xs font-bold text-slate-700">{g.label}</div>
                        <div className="text-[10px] text-slate-400">{g.subtitle} · {g.changes.length} change(s)</div>
                      </div>
                      <div className="p-2 space-y-1.5">
                        {g.changes.map(c => (
                          <div key={c.key} className="flex items-start gap-2 text-xs">
                            <span className="text-slate-400 shrink-0 w-20 text-[10px] font-bold uppercase tracking-wider">{c.label}</span>
                            <span className="flex-1 min-w-0">
                              {c.old && (
                                <span className="text-slate-400 line-through mr-2 break-words">{c.old}</span>
                              )}
                              <span className="text-indigo-700 font-bold break-words whitespace-pre-wrap">→ {c.new}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                  <button onClick={() => setConfirmKidSave(null)} className="bg-slate-100 text-slate-600 py-3 rounded-xl font-bold uppercase text-sm">
                    Cancel
                  </button>
                  <button onClick={() => performKidSave(confirmKidSave.payload)} className="bg-indigo-600 text-white py-3 rounded-xl font-bold uppercase text-sm shadow-lg">
                    Confirm Save
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {activeTab === 'meals' && (
          <div className="space-y-6">
            <div className="bg-amber-50 rounded-[2rem] p-6 border border-amber-100 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <StickyNote size={14} className="text-amber-600" />
                <span className="text-xs font-bold text-amber-600 uppercase tracking-widest">Daily Note</span>
              </div>
              <textarea
                key={selectedDate}
                defaultValue={dailyNoteFromDB}
                className="w-full bg-transparent border-none outline-none font-bold text-base text-amber-900 placeholder:text-amber-200 resize-none"
                placeholder="What's on today..."
                onChange={(e) => {
                  updateDayNote(e.target.value, selectedDate);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = el.scrollHeight + 'px';
                }}
              />
            </div>

            {MEAL_TYPES.map(type => {
              const m = (meals || []).find(x => x.id === `${selectedDate}_${type}`);
              const isEdit = editingRemark?.type === type;
              const dishList = Array.isArray(m?.dishes) ? m.dishes : [];

              return (
                <div key={type} className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-indigo-500" />
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                      {type}
                    </span>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => { setSelectingFor({ type }); setIsLibraryOpen(true); setCurrentCategoryId(null); }} 
                        className="p-2 bg-indigo-50 text-indigo-600 rounded-xl"
                      >
                        <PlusCircle size={16} />
                      </button>
                      <button 
                        onClick={() => addDishToMeal(type, SUGGESTED_MEALS[type][Math.floor(Math.random() * SUGGESTED_MEALS[type].length)])} 
                        className="p-2 bg-purple-50 text-purple-600 rounded-xl"
                      >
                        <Sparkles size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2 mb-4">
                    <input
                      type="text"
                      placeholder={`Add ${type} dish...`}
                      className="flex-1 bg-slate-50 border-none px-4 py-2 rounded-xl text-sm font-bold text-slate-700 outline-none"
                      value={manualInputs[type] || ''}
                      onChange={(e) => setManualInputs(prev => ({ ...prev, [type]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && addDishToMeal(type, manualInputs[type])}
                    />
                    <button onClick={() => addDishToMeal(type, manualInputs[type])} className="p-2 bg-slate-100 text-slate-600 rounded-xl">
                      <Send size={16} />
                    </button>
                  </div>

                  <div className="space-y-2 mb-4">
                    {dishList.map((dish, i) => (
                      <div key={i} className="flex items-center justify-between bg-slate-50 px-4 py-3 rounded-xl border border-slate-100">
                        <span className="text-sm font-bold text-slate-800 break-words flex-1 pr-2">{dish}</span>
                        <button onClick={() => removeDish(type, i)} className="text-slate-300 flex-shrink-0">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="bg-slate-100 rounded-xl p-3 border border-slate-200">
                    <div className="flex justify-between mb-1">
                      <span className="text-[8px] font-bold uppercase text-slate-400">Details</span>
                      <button
                        onClick={() => setEditingRemark(isEdit ? null : { type, value: m?.remark || '' })}
                        className={`${isEdit ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'} px-3 py-1.5 rounded-xl text-xs font-bold`}
                      >
                        {isEdit ? 'Cancel' : 'Edit'}
                      </button>
                    </div>
                    {isEdit ? (
                      <div className="space-y-2">
                        <textarea
                          ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
                          className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-bold min-h-[80px] resize-none"
                          rows={6}
                          value={editingRemark.value}
                          onChange={(e) => {
                            setEditingRemark({ ...editingRemark, value: e.target.value });
                            const el = e.target;
                            el.style.height = 'auto';
                            el.style.height = el.scrollHeight + 'px';
                          }}
                        />
                        <button 
                          onClick={() => saveMealNote(type)} 
                          className="w-full py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold uppercase shadow-lg"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="text-sm font-bold text-slate-600 leading-relaxed whitespace-pre-wrap">
                        {m?.remark || 'No details added...'}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Bible Verse - shown after all meals */}
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-[2rem] p-6 border border-indigo-100 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <BookOpen size={14} className="text-indigo-500" />
                <span className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Daily Verse</span>
              </div>
              <p className="text-sm font-bold text-indigo-900 leading-relaxed mb-2 italic">
                "{todayVerse.text}"
              </p>
              <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider">
                — {todayVerse.source}
              </p>
            </div>
          </div>
        )}

        {activeTab === 'groceries' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="Grocery item..." 
                className="flex-1 px-5 py-4 rounded-2xl bg-white border border-slate-200 outline-none font-bold text-sm shadow-sm" 
                value={newGrocery} 
                onChange={(e) => setNewGrocery(e.target.value)} 
                onKeyDown={(e) => e.key === 'Enter' && handleAddGrocery()} 
              />
              <button onClick={handleAddGrocery} className="bg-indigo-600 text-white px-5 rounded-2xl shadow-lg">
                <Plus size={24} />
              </button>
            </div>
            <div className="space-y-2">
              {(groceries || []).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0)).map(item => (
                <div key={item.id} className="bg-white p-5 rounded-2xl flex items-center gap-3 shadow-sm border border-slate-50">
                  <button onClick={() => updateDoc(getHubRef('groceries', item.id), { completed: !item.completed })} className="flex-shrink-0">
                    {item.completed ? <CheckCircle2 className="text-emerald-500" size={24} /> : <Circle className="text-slate-200" size={24} />}
                  </button>
                  <span className={`flex-1 text-sm font-bold break-words ${item.completed ? 'line-through text-slate-300' : 'text-slate-700'}`}>
                    {item.text}
                  </span>
                  <button onClick={() => deleteDoc(getHubRef('groceries', item.id))} className="text-slate-200 hover:text-red-500 flex-shrink-0">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-6">
            {/* ─── Profile ────────────────────────────────────────────────────── */}
            <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-xs font-bold text-indigo-600 uppercase mb-4 flex items-center gap-2">
                <Info size={14} /> Profile
              </h3>
              <div className="space-y-3">
                {/* Hub Name (admin-editable, shown in header) */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                  <p className="text-[9px] font-bold text-slate-400 uppercase mb-1">Hub Name</p>
                  {activeProfile.role === 'admin' && editingHubName ? (
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="text"
                        value={hubNameDraft}
                        onChange={(e) => setHubNameDraft(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveHubName()}
                        className="flex-1 px-3 py-2 bg-white rounded-lg font-bold text-xs outline-none border border-indigo-200"
                        autoFocus
                      />
                      <button onClick={handleSaveHubName} className="p-2 bg-indigo-600 text-white rounded-lg">
                        <CheckCircle2 size={14} />
                      </button>
                      <button onClick={() => { setEditingHubName(false); setHubNameDraft(''); }} className="p-2 bg-slate-200 text-slate-600 rounded-lg">
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <p className="font-bold text-sm text-slate-700">{hubProfile?.profile?.name || activeProfile.hubKey}</p>
                      {activeProfile.role === 'admin' && (
                        <button
                          onClick={() => { setEditingHubName(true); setHubNameDraft(hubProfile?.profile?.name || ''); }}
                          className="p-1.5 text-slate-300 hover:text-indigo-500 rounded-lg"
                        >
                          <Info size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* User's own display name */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                  <p className="text-[9px] font-bold text-slate-400 uppercase mb-1">Your Name</p>
                  {editingProfileName ? (
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="text"
                        value={profileNameDraft}
                        onChange={(e) => setProfileNameDraft(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveProfileName()}
                        className="flex-1 px-3 py-2 bg-white rounded-lg font-bold text-xs outline-none border border-indigo-200"
                        autoFocus
                      />
                      <button onClick={handleSaveProfileName} className="p-2 bg-indigo-600 text-white rounded-lg">
                        <CheckCircle2 size={14} />
                      </button>
                      <button onClick={() => { setEditingProfileName(false); setProfileNameDraft(''); }} className="p-2 bg-slate-200 text-slate-600 rounded-lg">
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <p className="font-bold text-sm text-slate-700">{activeProfile.name}</p>
                      <button
                        onClick={() => { setEditingProfileName(true); setProfileNameDraft(activeProfile.name); }}
                        className="p-1.5 text-slate-300 hover:text-indigo-500 rounded-lg"
                      >
                        <Info size={14} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                  <p className="text-[9px] font-bold text-slate-400 uppercase mb-1 flex items-center gap-1.5">
                    Hub ID <span className="text-slate-300 normal-case font-normal">— tap to copy</span>
                  </p>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(activeProfile.hubKey);
                      } catch {
                        const ta = document.createElement('textarea');
                        ta.value = activeProfile.hubKey;
                        ta.style.position = 'fixed';
                        ta.style.opacity = '0';
                        document.body.appendChild(ta);
                        ta.select();
                        try { document.execCommand('copy'); } catch {}
                        document.body.removeChild(ta);
                      }
                      showToast('Hub ID copied — paste in Telegram', 'success');
                    }}
                    className="font-mono text-[11px] text-slate-700 break-all text-left w-full active:scale-95 transition-transform leading-relaxed"
                  >
                    {activeProfile.hubKey} <span className="text-indigo-500">📋</span>
                  </button>
                </div>
              </div>
            </div>

            {/* ─── Members (admin only) ─────────────────────────────────────────── */}
            {activeProfile?.role === 'admin' && (
              <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-bold text-indigo-600 uppercase flex items-center gap-2">
                    <Users2 size={14} /> Members ({members.length})
                  </h3>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setInviteAdultOpen(true)}
                      className="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase active:scale-95 flex items-center gap-1"
                    >
                      <UserPlus size={11} /> Adult
                    </button>
                    <button
                      onClick={() => setInviteChildOpen(true)}
                      className="bg-amber-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase active:scale-95 flex items-center gap-1"
                    >
                      <UserPlus size={11} /> Child
                    </button>
                  </div>
                </div>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {members.map(m => (
                    <div key={m.uid} className="bg-slate-50 p-3 rounded-xl">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-bold text-slate-800 truncate">{m.display_name}</p>
                            <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-full ${
                              m.role === 'admin' ? 'bg-indigo-100 text-indigo-700' :
                              m.role === 'child' ? 'bg-amber-100 text-amber-700' :
                              'bg-slate-200 text-slate-600'
                            }`}>
                              {m.role}
                            </span>
                            {m.status === 'disabled' && (
                              <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
                                disabled
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-400 truncate">
                            {m.email || m.synthetic_email}
                            {m.username && ` · @${m.username}`}
                          </p>
                          {m.needs_password_setup && (
                            <p className="text-[9px] text-amber-600 mt-1">⏳ Setup pending</p>
                          )}
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              const fn = httpsCallable(firebaseRefs.functions, 'resetMemberPassword');
                              const res = await fn({ uid: m.uid });
                              setInviteResult({
                                display_name: m.display_name,
                                email: res.data.email,
                                role: 'member',
                                created: false,
                                setup_link: res.data.setup_link,
                                email_sent: res.data.email_sent,
                                email_error: res.data.email_error,
                              });
                            } catch (e) {
                              showToast(e.message || 'Reset failed', 'error');
                            }
                          }}
                          className="bg-white border border-slate-200 px-2 py-1 rounded-lg text-[9px] font-bold uppercase text-slate-500 active:scale-95"
                          title="Send password reset email"
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  ))}
                  {members.length === 0 && (
                    <p className="text-[10px] text-slate-400 text-center py-4">No members yet</p>
                  )}
                </div>
                <p className="text-[9px] text-slate-400 mt-3 leading-relaxed">
                  💡 Invite actions generate CLI commands. Open WSL terminal & paste to execute.
                </p>
              </div>
            )}

            {/* ─── Security (Change Password) ────────────────────────────────── */}
            <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-xs font-bold text-indigo-600 uppercase mb-4 flex items-center gap-2">
                <Lock size={14} /> Security
              </h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl">
                  <div>
                    <p className="text-sm font-bold text-slate-800">Password</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {user?.providerData?.[0]?.providerId === 'google.com'
                        ? 'Signed in with Google'
                        : 'Last changed: unknown'}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setChangePwdOpen(true);
                      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('');
                      setChangePwdError(null);
                    }}
                    disabled={user?.providerData?.[0]?.providerId === 'google.com'}
                    className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-[10px] font-bold uppercase active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Change
                  </button>
                </div>
                {user?.providerData?.[0]?.providerId === 'google.com' && (
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Google sign-in users manage their password through Google Account settings.
                  </p>
                )}
              </div>
            </div>

            {/* ─── Log Out ──────────────────────────────────────────────────────── */}
            <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-xs font-bold text-indigo-600 uppercase mb-4 flex items-center gap-2">
                <Fingerprint size={14} /> Account
              </h3>
              {confirmLogout ? (
                <div className="space-y-3">
                  <p className="text-[12px] text-slate-600">Sign out of this device? Your data stays in the hub.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleLogout}
                      className="flex-1 py-3 bg-red-500 text-white rounded-xl text-xs font-bold uppercase"
                    >
                      Sign Out
                    </button>
                    <button
                      onClick={() => setConfirmLogout(false)}
                      className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold uppercase"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmLogout(true)}
                  className="w-full py-4 text-slate-400 font-bold text-xs uppercase bg-slate-100 rounded-xl"
                >
                  Log Out
                </button>
              )}
            </div>

            <p className="text-center text-[10px] text-slate-300 font-bold uppercase tracking-widest pt-2">
              {APP_VERSION}
            </p>
          </div>
        )}
      </main>

      {inviteAdultOpen && (
        <InviteAdultModal
          hubKey={activeProfile?.hubKey}
          functions={firebaseRefs?.functions}
          onClose={() => setInviteAdultOpen(false)}
          onResult={setInviteResult}
        />
      )}

      {inviteChildOpen && (
        <InviteChildModal
          hubKey={activeProfile?.hubKey}
          kids={membersKids.length > 0 ? membersKids : kids}
          functions={firebaseRefs?.functions}
          onClose={() => setInviteChildOpen(false)}
          onResult={setInviteResult}
        />
      )}

      {inviteResult && (
        <InviteResultModal result={inviteResult} onClose={() => setInviteResult(null)} />
      )}

      {changePwdOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-3">
          <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden">
            <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-amber-50 to-orange-50">
              <div className="flex items-center gap-2">
                <Lock size={18} className="text-amber-600" />
                <h2 className="text-sm font-bold text-slate-900 uppercase">Change Password</h2>
              </div>
              <button
                onClick={() => { setChangePwdOpen(false); setChangePwdError(null); }}
                className="p-2 text-slate-300 bg-white rounded-xl"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-3">
              {changePwdError && (
                <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs border border-red-100">
                  {changePwdError}
                </div>
              )}
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Current password</label>
                <input
                  type="password"
                  autoFocus
                  value={currentPwd}
                  onChange={(e) => { setCurrentPwd(e.target.value); setChangePwdError(null); }}
                  disabled={changePwdLoading}
                  className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">New password (8+ chars)</label>
                <input
                  type="password"
                  value={newPwd}
                  onChange={(e) => { setNewPwd(e.target.value); setChangePwdError(null); }}
                  disabled={changePwdLoading}
                  className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Confirm new password</label>
                <input
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => { setConfirmPwd(e.target.value); setChangePwdError(null); }}
                  disabled={changePwdLoading}
                  className="w-full mt-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
                  autoComplete="new-password"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => { setChangePwdOpen(false); setChangePwdError(null); }}
                  disabled={changePwdLoading}
                  className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold uppercase disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!currentPwd) { setChangePwdError('請輸入現有密碼'); return; }
                    if (newPwd.length < 8) { setChangePwdError('新密碼至少 8 個字元'); return; }
                    if (newPwd !== confirmPwd) { setChangePwdError('新密碼兩次輸入唔一致'); return; }
                    if (newPwd === currentPwd) { setChangePwdError('新密碼唔可以同舊的一樣'); return; }
                    setChangePwdLoading(true);
                    const res = await handleChangePassword(currentPwd, newPwd);
                    setChangePwdLoading(false);
                    if (res.ok) {
                      setChangePwdOpen(false);
                      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('');
                      alert('✓ 密碼已更新');
                    } else {
                      setChangePwdError(res.error || '改密碼失敗');
                    }
                  }}
                  disabled={changePwdLoading || !currentPwd || !newPwd || !confirmPwd}
                  className="flex-1 py-3 bg-amber-500 text-white rounded-xl text-xs font-bold uppercase active:scale-95 transition-transform disabled:opacity-50 shadow-md"
                >
                  {changePwdLoading ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isLibraryOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-3">
          <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="p-6 border-b flex justify-between items-center bg-white sticky top-0 z-10">
              <div className="flex items-center gap-2">
                {currentCategoryId && (
                  <button onClick={() => setCurrentCategoryId(null)} className="p-2 bg-slate-100 rounded-xl">
                    <ChevronLeft size={18} />
                  </button>
                )}
                <h2 className="text-sm font-bold text-slate-900 uppercase">
                  {currentCategoryId ? (categories || []).find(c => c.id === currentCategoryId)?.name : "Categories"}
                </h2>
              </div>
              <button onClick={() => setIsLibraryOpen(false)} className="p-2 text-slate-300 bg-slate-50 rounded-xl">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              {!currentCategoryId ? (
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="Add Category..." 
                      className="flex-1 px-4 py-3 bg-slate-50 rounded-xl font-bold text-sm outline-none" 
                      value={newCategoryName} 
                      onChange={(e) => setNewCategoryName(e.target.value)} 
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
                    />
                    <button onClick={handleCreateCategory} className="bg-indigo-600 text-white px-4 rounded-xl">
                      <FolderPlus size={18} />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {(categories || []).map(cat => (
                      <div
                        key={cat.id}
                        className="w-full flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100"
                      >
                        {editingCategory === cat.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input
                              type="text"
                              value={editingCategoryName}
                              onChange={(e) => setEditingCategoryName(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleEditCategory()}
                              className="flex-1 px-3 py-2 bg-white rounded-xl font-bold text-xs outline-none border border-indigo-200"
                              autoFocus
                            />
                            <button onClick={handleEditCategory} className="p-2 bg-indigo-600 text-white rounded-xl">
                              <CheckCircle2 size={14} />
                            </button>
                            <button onClick={() => { setEditingCategory(null); setEditingCategoryName(''); }} className="p-2 bg-slate-200 text-slate-600 rounded-xl">
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => setCurrentCategoryId(cat.id)}
                              className="flex items-center gap-3 flex-1"
                            >
                              <Tag size={16} className="text-indigo-500" />
                              <span className="font-bold text-slate-700 uppercase text-xs">{cat.name}</span>
                              <span className="text-[9px] font-bold text-slate-300 uppercase">
                                {(dishes || []).filter(d => d.categoryId === cat.id).length} Dishes
                              </span>
                            </button>
                            <div className="flex gap-1">
                              <button
                                onClick={() => { setEditingCategory(cat.id); setEditingCategoryName(cat.name); }}
                                className="p-2 text-slate-300 hover:text-indigo-500 rounded-xl"
                              >
                                <Info size={14} />
                              </button>
                              <button
                                onClick={() => handleDeleteCategory(cat.id)}
                                className="p-2 text-slate-300 hover:text-red-500 rounded-xl"
                              >
                                <Trash2 size={14} />
                              </button>
                              <ChevronRightIcon size={14} className="text-slate-300 self-center" />
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="Add single dish..." 
                      className="flex-1 px-4 py-3 bg-slate-50 rounded-xl font-bold text-sm outline-none" 
                      value={newDishName} 
                      onChange={(e) => setNewDishName(e.target.value)} 
                      onKeyDown={(e) => e.key === 'Enter' && handleAddDishToLib()}
                    />
                    <button onClick={handleAddDishToLib} className="bg-indigo-600 text-white px-4 rounded-xl">
                      <Plus size={18} />
                    </button>
                  </div>

                  <label className="flex items-center justify-center gap-3 px-5 py-4 bg-emerald-50 text-emerald-600 rounded-2xl border border-dashed border-emerald-200 cursor-pointer">
                    <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelUpload} disabled={isImporting && importPendingList.length > 0} />
                    <FileUp size={18} />
                    <span className="text-xs font-bold uppercase">Bulk Upload</span>
                  </label>

                  {importPendingList.length > 0 && (
                    <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-indigo-700 uppercase">
                          Import Review (selected {importPendingList.filter(i => i.selected).length})
                        </span>
                        <button onClick={() => { setImportPendingList([]); setIsImporting(false); }} className="text-indigo-400 hover:text-indigo-600">
                          <X size={16} />
                        </button>
                      </div>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {importPendingList.map((item, idx) => (
                          <label key={idx} className="flex items-center gap-2 p-2 bg-white rounded-xl cursor-pointer">
                            <input
                              type="checkbox"
                              checked={item.selected}
                              onChange={(e) => {
                                const updated = [...importPendingList];
                                updated[idx].selected = e.target.checked;
                                setImportPendingList(updated);
                              }}
                              className="w-4 h-4 rounded accent-indigo-600"
                            />
                            <span className={`text-xs font-bold ${item.selected ? 'text-slate-700' : 'text-slate-400 line-through'}`}>
                              {item.name}
                            </span>
                          </label>
                        ))}
                      </div>
                      <button
                        onClick={confirmImport}
                        className="w-full py-3 bg-indigo-600 text-white rounded-xl text-xs font-bold uppercase"
                      >
                        Confirm Import (({importPendingList.filter(i => i.selected).length})
                      </button>
                    </div>
                  )}

                  <div className="space-y-2 pb-10">
                    {(dishes || []).filter(d => d.categoryId === currentCategoryId).map(dish => (
                      <div key={dish.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                        <span className="font-bold text-slate-700 text-xs break-words pr-2">{dish.name}</span>
                        <div className="flex gap-2 flex-shrink-0">
                          <button onClick={() => deleteDoc(getHubRef('dishes', dish.id))} className="text-slate-200 hover:text-red-500 p-1">
                            <Trash2 size={14} />
                          </button>
                          {selectingFor && (
                            <button 
                              onClick={() => addDishToMeal(selectingFor.type, dish.name)} 
                              className="bg-indigo-600 text-white px-3 py-1.5 rounded-xl font-bold text-xs uppercase"
                            >
                              Add
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast notification (floats above everything) */}
      {toast && (
        <div
          key={toast.id}
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-2xl shadow-2xl font-bold text-sm uppercase tracking-wider animate-[slideDown_0.2s_ease-out] ${
            toast.tone === 'success' ? 'bg-emerald-500 text-white' :
            toast.tone === 'warn'    ? 'bg-amber-500 text-white' :
            toast.tone === 'error'   ? 'bg-red-500 text-white' :
                                       'bg-slate-900 text-white'
          }`}
          style={{ animation: 'slideDown 0.2s ease-out' }}
        >
          {toast.message}
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-100 px-6 py-5 pb-9 flex justify-between items-center z-40 shadow-xl">
        <button
          onClick={() => setActiveTab('schedule')}
          className={`flex flex-col items-center gap-1.5 transition-all active:scale-90 ${activeTab === 'schedule' ? 'text-indigo-600' : 'text-slate-300'}`}
        >
          <Sun size={26} strokeWidth={2.5} />
          <span className="text-[9px] font-bold uppercase">Schedule</span>
        </button>
        <button
          onClick={() => setActiveTab('meals')}
          className={`flex flex-col items-center gap-1.5 transition-all active:scale-90 ${activeTab === 'meals' ? 'text-indigo-600' : 'text-slate-300'}`}
        >
          <Utensils size={26} strokeWidth={2.5} />
          <span className="text-[9px] font-bold uppercase">Meals</span>
        </button>
        <button
          onClick={() => setActiveTab('groceries')}
          className={`flex flex-col items-center gap-1.5 transition-all active:scale-90 ${activeTab === 'groceries' ? 'text-indigo-600' : 'text-slate-300'}`}
        >
          <ShoppingCart size={26} strokeWidth={2.5} />
          <span className="text-[9px] font-bold uppercase">Grocery</span>
        </button>
        <button
          onClick={() => setActiveTab('kids')}
          className={`flex flex-col items-center gap-1.5 transition-all active:scale-90 ${activeTab === 'kids' ? 'text-indigo-600' : 'text-slate-300'}`}
        >
          <Users size={26} strokeWidth={2.5} />
          <span className="text-[9px] font-bold uppercase">Kids</span>
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex flex-col items-center gap-1.5 transition-all active:scale-90 ${activeTab === 'settings' ? 'text-indigo-600' : 'text-slate-300'}`}
        >
          <Fingerprint size={26} strokeWidth={2.5} />
          <span className="text-[9px] font-bold uppercase">Hub</span>
        </button>
      </nav>
    </div>
  );
}