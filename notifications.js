// notifications.js — shared notification logic for Aurix Bank
// Import the pieces you need into any page's existing <script type="module"> block:
//
//   import { logLoginEvent, initNotificationBell } from './notifications.js';
//
// No new Firebase app is created here — pass in the `db` and `uid` you already have.

import { doc, getDoc, setDoc, updateDoc, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ───────────────────────── helpers ─────────────────────────

function toMillis(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Date.now();
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
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
  return `${n < 0 ? '−' : ''}$${parts[0]}.${parts[1]}`;
}

function shortUA(ua) {
  if (!ua) return 'Aurix Bank';
  if (/Mobi/.test(ua)) return 'Mobile device';
  if (/Edg/.test(ua)) return 'Edge browser';
  if (/Chrome/.test(ua)) return 'Chrome browser';
  if (/Firefox/.test(ua)) return 'Firefox browser';
  if (/Safari/.test(ua)) return 'Safari browser';
  return 'Web browser';
}

// ───────────────────── login history (new) ─────────────────────
// Call this right after a successful login (after OTP verification passes),
// from login.html. Creates loginHistory/{uid} the first time, appends after.

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
    // Doc doesn't exist yet on a user's first-ever login
    await setDoc(ref, { items: [entry] });
  }
}

// ───────────────────── fetch + unify everything ─────────────────────

export async function getAllNotifications(db, uid) {
  const [txnSnap, chqSnap, loanSnap, schedSnap, loginSnap] = await Promise.all([
    getDoc(doc(db, 'transactions', uid)),
    getDoc(doc(db, 'chequeDeposits', uid)),
    getDoc(doc(db, 'loanApplications', uid)),
    getDoc(doc(db, 'scheduledTransfers', uid)),
    getDoc(doc(db, 'loginHistory', uid))
  ]);

  const notifications = [];

  // Regular transactions — written only after success, so always "succeeded"
  (txnSnap.exists() ? (txnSnap.data().items || []) : []).forEach(t => {
    notifications.push({
      type: 'transaction',
      status: 'succeeded',
      title: t.description,
      sub: `${money(t.amount)} · ${t.category}`,
      time: toMillis(t.date)
    });
  });

  // Cheque deposits — has a real status
  (chqSnap.exists() ? (chqSnap.data().items || []) : []).forEach(d => {
    const s = (d.status || '').toLowerCase();
    const status = s.includes('declin') ? 'declined' : s.includes('pend') ? 'pending' : 'succeeded';
    notifications.push({
      type: 'cheque',
      status,
      title: `Cheque deposit — ${money(d.amount)}`,
      sub: d.status,
      time: toMillis(d.date)
    });
  });

  // Loan applications — has a real status
  (loanSnap.exists() ? (loanSnap.data().items || []) : []).forEach(l => {
    const status = l.status === 'Declined' ? 'declined' : l.status === 'Approved' ? 'succeeded' : 'pending';
    notifications.push({
      type: 'loan',
      status,
      title: `Loan application — ${money(l.amount)}`,
      sub: l.status,
      time: toMillis(l.submittedAt)
    });
  });

  // Scheduled transfers
  (schedSnap.exists() ? (schedSnap.data().items || []) : []).forEach(s => {
    const status = s.status === 'completed' ? 'succeeded' : 'pending';
    notifications.push({
      type: 'scheduled',
      status,
      title: `Scheduled transfer to ${s.recipientName}`,
      sub: `${money(s.amount)} · ${s.status}`,
      time: toMillis(s.date)
    });
  });

  // Sign-ins
  (loginSnap.exists() ? (loginSnap.data().items || []) : []).forEach(entry => {
    notifications.push({
      type: 'login',
      status: 'info',
      title: 'New sign-in to your account',
      sub: shortUA(entry.userAgent),
      time: toMillis(entry.date)
    });
  });

  notifications.sort((a, b) => b.time - a.time);
  return notifications;
}

// ───────────────────── rendering ─────────────────────

function pillClass(status) {
  if (status === 'succeeded') return 'approved';
  if (status === 'declined') return 'declined';
  if (status === 'pending') return 'pending';
  return null; // logins get no pill
}

function renderRow(n, compact) {
  const pc = pillClass(n.status);
  const pill = pc ? `<span class="status-pill ${pc}" style="margin-left:8px; vertical-align:middle;">${n.status}</span>` : '';

  if (compact) {
    return `
      <div class="notif-row">
        <div class="dotmark"></div>
        <div>
          <div class="txt">${n.title}${pill}</div>
          <div class="time">${timeAgo(n.time)}${n.sub ? ' · ' + n.sub : ''}</div>
        </div>
      </div>`;
  }

  return `
    <div class="txn-row">
      <div class="who">
        <span class="desc">${n.title}</span>
        <span class="meta">${timeAgo(n.time)} · ${n.sub}</span>
      </div>
      ${pill}
    </div>`;
}

// Renders up to 6 most-recent items into the bell dropdown panel
export function renderNotificationDropdown(list, container) {
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><div class="ic">⚑</div><p>No notifications yet.</p></div>`;
    return;
  }
  container.innerHTML = list.slice(0, 6).map(n => renderRow(n, true)).join('');
}

// Renders the full filtered list on notifications.html
// filter: 'all' | 'transactions' | 'logins'
export function renderNotificationList(list, container, filter = 'all') {
  const filtered = filter === 'all'
    ? list
    : filter === 'logins'
      ? list.filter(n => n.type === 'login')
      : list.filter(n => n.type !== 'login');

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div class="ic">⚑</div><p>No notifications to show.</p></div>`;
    return;
  }
  container.innerHTML = filtered.map(n => renderRow(n, false)).join('');
}

// ───────────────────── bell dropdown wiring ─────────────────────
// Call once per page, after you know the user is signed in:
//   await initNotificationBell(db, user.uid);
//
// It finds the existing `.bell` element in your topbar, builds a dropdown
// panel the first time it's called, and wires click-to-toggle + click-outside-to-close.

export async function initNotificationBell(db, uid) {
  const bell = document.querySelector('.bell');
  if (!bell) return;

  let panel = document.getElementById('notif-dropdown-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-dropdown-panel';
    panel.style.cssText = `
      position:fixed; width:320px; max-height:420px; overflow-y:auto;
      background:var(--panel); border:1px solid var(--line); border-radius:8px;
      box-shadow:0 20px 40px -12px rgba(30,42,61,0.25); padding:6px 16px; z-index:200; display:none;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--line);';
    header.innerHTML = `<span style="font-size:13px; font-weight:600; color:var(--paper);">Notifications</span>
                         <a href="notifications.html" style="font-size:12.5px; color:var(--brass);">View all</a>`;
    panel.appendChild(header);

    const body = document.createElement('div');
    body.id = 'notif-dropdown-body';
    panel.appendChild(body);

    document.body.appendChild(panel);
  }

  let list = [];
  try {
    list = await getAllNotifications(db, uid);
  } catch (e) {
    console.error('Could not load notifications:', e);
  }

  renderNotificationDropdown(list, document.getElementById('notif-dropdown-body'));

  const badge = bell.querySelector('.dotbadge');
  if (badge) badge.style.display = list.some(n => n.status === 'pending') ? 'block' : 'none';

  bell.style.cursor = 'pointer';
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = bell.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.right = `${window.innerWidth - rect.right}px`;
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });

  document.addEventListener('click', (e) => {
    if (panel.style.display === 'block' && !panel.contains(e.target) && e.target !== bell) {
      panel.style.display = 'none';
    }
  });
}