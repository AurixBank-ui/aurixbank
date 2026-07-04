// notifications.js — shared notification logic for Aurix Bank
//
// Exports:
//   logLoginEvent(db, uid)          — call after successful OTP verify in login.html
//   getAllNotifications(db, uid)     — fetch + unify all notification sources
//   renderNotificationDropdown(list, container) — compact bell panel
//   renderNotificationList(list, container, filter) — full page list
//   initNotificationBell(db, uid)   — wire up the bell icon in the topbar

import { doc, getDoc, setDoc, updateDoc, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ── Inject status-pill CSS once (so it works on every page) ───
(function injectPillStyles() {
  if (document.getElementById('aurix-notif-styles')) return;
  const style = document.createElement('style');
  style.id = 'aurix-notif-styles';
  style.textContent = `
    .status-pill {
      display:inline-block; font-size:11px; font-weight:600; letter-spacing:0.05em;
      padding:2px 10px; border-radius:20px; white-space:nowrap; vertical-align:middle;
    }
    .status-pill.succeeded, .status-pill.approved {
      background:rgba(62,145,99,0.12); color:#2E7A4C;
    }
    .status-pill.declined, .status-pill.failed {
      background:rgba(196,60,60,0.1); color:#B3261E;
    }
    .status-pill.pending {
      background:rgba(196,150,60,0.1); color:#8A6A1E;
    }
    .status-pill.info {
      background:rgba(62,111,166,0.1); color:#1E4D8C;
    }
    .notif-row-full {
      display:flex; justify-content:space-between; align-items:center;
      padding:13px 0; border-bottom:1px solid var(--line);
    }
    .notif-row-full:last-child { border-bottom:none; }
    .notif-row-full .who { display:flex; flex-direction:column; gap:3px; }
    .notif-row-full .desc { font-size:14px; font-weight:500; color:var(--paper); }
    .notif-row-full .meta { font-size:12px; color:var(--slate-dim); }
    .notif-type-icon {
      width:32px; height:32px; border-radius:50%; display:flex;
      align-items:center; justify-content:center; font-size:13px;
      flex-shrink:0; margin-right:12px;
    }
    .notif-row-full-inner { display:flex; align-items:center; flex:1; }
  `;
  document.head.appendChild(style);
})();

// ── Helpers ────────────────────────────────────────────────────
function toMillis(value) {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  // Firestore Timestamp object
  if (typeof value.toMillis === 'function') return value.toMillis();
  return Date.now();
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 0) return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(months / 12)} yr ago`;
}

function money(n) {
  const parts = Math.abs(n || 0).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = (n || 0) < 0 ? '−' : '+';
  return `${sign}$${parts[0]}.${parts[1]}`;
}

function shortUA(ua) {
  if (!ua) return 'Aurix Bank';
  if (/Mobi|Android/i.test(ua)) return 'Mobile device';
  if (/Edg/i.test(ua)) return 'Edge browser';
  if (/Chrome/i.test(ua)) return 'Chrome browser';
  if (/Firefox/i.test(ua)) return 'Firefox browser';
  if (/Safari/i.test(ua)) return 'Safari browser';
  return 'Web browser';
}

// Icon and colors per notification type
const TYPE_META = {
  transaction: { icon: '⇄', bg: 'rgba(62,111,166,0.1)', color: '#3E6FA6' },
  cheque:      { icon: '⎘', bg: 'rgba(62,111,166,0.1)', color: '#3E6FA6' },
  loan:        { icon: '%', bg: 'rgba(196,150,60,0.1)',  color: '#8A6A1E' },
  scheduled:   { icon: '◷', bg: 'rgba(62,111,166,0.1)', color: '#3E6FA6' },
  login:       { icon: '◎', bg: 'rgba(62,145,99,0.1)',  color: '#2E7A4C' },
};

// ── Log a login event ──────────────────────────────────────────
export async function logLoginEvent(db, uid, extra = {}) {
  const ref = doc(db, 'loginHistory', uid);
  const entry = {
    date: new Date().toISOString(),
    userAgent: (typeof navigator !== 'undefined') ? navigator.userAgent : '',
    ...extra
  };
  try {
    await updateDoc(ref, { items: arrayUnion(entry) });
  } catch (e) {
    // Document doesn't exist yet on first login — create it
    try {
      await setDoc(ref, { items: [entry] });
    } catch (e2) {
      console.error('Could not log login event (check Firestore rules for loginHistory):', e2);
    }
  }
}

// ── Safely read one Firestore doc (returns null on any error) ──
async function safeGet(db, collectionName, uid) {
  try {
    const snap = await getDoc(doc(db, collectionName, uid));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn(`notifications.js: could not read "${collectionName}" — check Firestore rules.`, e.message);
    return null;
  }
}

// ── Fetch and unify all notification sources ───────────────────
export async function getAllNotifications(db, uid) {
  // Each collection is read independently so a rules error on one
  // doesn't wipe out the rest.
  const [txnData, chqData, loanData, schedData, loginData] = await Promise.all([
    safeGet(db, 'transactions',      uid),
    safeGet(db, 'chequeDeposits',    uid),
    safeGet(db, 'loanApplications',  uid),
    safeGet(db, 'scheduledTransfers',uid),
    safeGet(db, 'loginHistory',      uid),
  ]);

  const notifications = [];

  // ── Transactions (always "completed" — only written on success) ──
  (txnData?.items || []).forEach(t => {
    if (!t.description || !t.date) return;
    const isPos = (t.amount || 0) >= 0;
    notifications.push({
      type:   'transaction',
      status: 'succeeded',
      title:  t.description,
      sub:    `${money(t.amount)} · ${t.category || 'Transaction'}`,
      time:   toMillis(t.date),
    });
  });

  // ── Cheque deposits ──────────────────────────────────────────
  (chqData?.items || []).forEach(d => {
    if (!d.date) return;
    const s = (d.status || '').toLowerCase();
    const status = s.includes('declin') || s.includes('fail') ? 'declined'
                 : s.includes('pend')                         ? 'pending'
                 : 'succeeded';
    notifications.push({
      type:   'cheque',
      status,
      title:  `Cheque deposit — ${d.account || 'account'}`,
      sub:    `$${Math.abs(d.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} · ${d.status}`,
      time:   toMillis(d.date),
    });
  });

  // ── Loan applications ────────────────────────────────────────
  (loanData?.items || []).forEach(l => {
    if (!l.submittedAt) return;
    const status = l.status === 'Declined' ? 'declined'
                 : l.status === 'Approved' ? 'succeeded'
                 : 'pending';
    const typeLabel = { personal: 'Personal loan', auto: 'Auto loan', home: 'Home loan', student: 'Student loan' };
    notifications.push({
      type:   'loan',
      status,
      title:  `${typeLabel[l.type] || 'Loan'} application`,
      sub:    `$${(l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} · ${l.status}`,
      time:   toMillis(l.submittedAt),
    });
  });

  // ── Scheduled transfers ──────────────────────────────────────
  (schedData?.items || []).forEach(s => {
    if (!s.date) return;
    const status = s.status === 'completed' ? 'succeeded'
                 : s.status === 'failed'    ? 'declined'
                 : 'pending';
    notifications.push({
      type:   'scheduled',
      status,
      title:  `Scheduled transfer to ${s.recipientName || 'recipient'}`,
      sub:    `$${(s.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} · ${s.status}`,
      time:   toMillis(s.date),
    });
  });

  // ── Sign-ins ─────────────────────────────────────────────────
  (loginData?.items || []).forEach(entry => {
    if (!entry.date) return;
    notifications.push({
      type:   'login',
      status: 'info',
      title:  'New sign-in to your account',
      sub:    shortUA(entry.userAgent),
      time:   toMillis(entry.date),
    });
  });

  // Newest first
  notifications.sort((a, b) => b.time - a.time);
  return notifications;
}

// ── Render helpers ─────────────────────────────────────────────
function pill(status) {
  if (!status || status === 'info') return '';
  const label = status === 'succeeded' ? 'Completed' : status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="status-pill ${status}">${label}</span>`;
}

// Compact row for the bell dropdown
function compactRow(n) {
  const m = TYPE_META[n.type] || TYPE_META.transaction;
  return `
    <div class="notif-row">
      <div class="dotmark" style="background:${m.color};"></div>
      <div style="flex:1; min-width:0;">
        <div class="txt">${n.title} ${pill(n.status)}</div>
        <div class="time">${timeAgo(n.time)}${n.sub ? ' · ' + n.sub : ''}</div>
      </div>
    </div>`;
}

// Full row for notifications.html
function fullRow(n) {
  const m = TYPE_META[n.type] || TYPE_META.transaction;
  return `
    <div class="notif-row-full">
      <div class="notif-row-full-inner">
        <div class="notif-type-icon" style="background:${m.bg}; color:${m.color};">${m.icon}</div>
        <div class="who">
          <span class="desc">${n.title}</span>
          <span class="meta">${timeAgo(n.time)} · ${n.sub}</span>
        </div>
      </div>
      ${pill(n.status)}
    </div>`;
}

// ── renderNotificationDropdown ─────────────────────────────────
// Compact list for the bell panel (called from dashboard + initNotificationBell)
export function renderNotificationDropdown(list, container) {
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div class="empty-state" style="padding:24px 0;"><div class="ic">⚑</div><p>No notifications yet.</p></div>`;
    return;
  }
  container.innerHTML = list.slice(0, 8).map(n => compactRow(n)).join('');
}

// ── renderNotificationList ─────────────────────────────────────
// Full list for notifications.html
// filter: 'all' | 'transactions' | 'logins'
export function renderNotificationList(list, container, filter = 'all') {
  if (!container) return;

  let filtered;
  if (filter === 'all') {
    filtered = list;
  } else if (filter === 'logins') {
    filtered = list.filter(n => n.type === 'login');
  } else {
    // 'transactions' tab = everything that is NOT a login
    filtered = list.filter(n => n.type !== 'login');
  }

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div class="ic">⚑</div><p>No notifications to show.</p></div>`;
    return;
  }

  container.innerHTML = filtered.map(n => fullRow(n)).join('');
}

// ── initNotificationBell ───────────────────────────────────────
// Call once per page after the user is confirmed signed in.
// Guards against being wired twice on the same page.
let bellWired = false;

export async function initNotificationBell(db, uid) {
  const bell = document.querySelector('.bell');
  if (!bell) return;

  // Build the dropdown panel once
  let panel = document.getElementById('notif-dropdown-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-dropdown-panel';
    Object.assign(panel.style, {
      position:  'fixed',
      width:     '320px',
      maxHeight: '420px',
      overflowY: 'auto',
      background: 'var(--panel)',
      border:    '1px solid var(--line)',
      borderRadius: '8px',
      boxShadow: '0 20px 40px -12px rgba(30,42,61,0.25)',
      padding:   '0 16px 8px',
      zIndex:    '200',
      display:   'none',
    });

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:14px 0 12px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--panel);';
    header.innerHTML = `
      <span style="font-size:13px; font-weight:700; color:var(--paper);">Notifications</span>
      <a href="notifications.html" style="font-size:12.5px; color:var(--brass);">View all</a>`;
    panel.appendChild(header);

    const body = document.createElement('div');
    body.id = 'notif-dropdown-body';
    panel.appendChild(body);

    document.body.appendChild(panel);
  }

  // Load and render notifications
  let list = [];
  try {
    list = await getAllNotifications(db, uid);
  } catch (e) {
    console.error('Bell: could not load notifications:', e);
  }

  const body = document.getElementById('notif-dropdown-body');
  if (body) renderNotificationDropdown(list, body);

  // Show badge dot if there are any pending items
  const badge = bell.querySelector('.dotbadge');
  if (badge) {
    const hasPending = list.some(n => n.status === 'pending');
    badge.style.display = hasPending ? 'block' : 'none';
  }

  // Wire click events only once per page
  if (!bellWired) {
    bellWired = true;
    bell.style.cursor = 'pointer';

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = bell.getBoundingClientRect();
      panel.style.top   = `${rect.bottom + 8}px`;
      panel.style.right = `${window.innerWidth - rect.right}px`;
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
      if (panel.style.display === 'block' && !panel.contains(e.target) && !bell.contains(e.target)) {
        panel.style.display = 'none';
      }
    });
  }
}