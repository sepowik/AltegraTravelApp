// Small DOM helpers shared by the views.
import { t } from './i18n.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function options(list, selected, { value = (x) => x, label = (x) => x, empty } = {}) {
  const head = empty != null ? `<option value="">${esc(empty)}</option>` : '';
  return head + list.map((x) => {
    const v = value(x);
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(label(x))}</option>`;
  }).join('');
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  navigator.vibrate?.(20);
  toast(`${what} ✓`);
}

// Bottom sheet dialog. `body` is HTML; `bind(dialog, close)` wires up its controls.
export function sheet(title, body, bind) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="${esc(t('close'))}">✕</button></div><div class="sheet-body">${body}</div>`;
  document.body.appendChild(dlg);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.querySelector('[data-close]').onclick = close;
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.showModal();
  bind?.(dlg, close);
  return close;
}

export function confirmSheet(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    const close = sheet(title, `<p>${esc(text)}</p><div class="row gap"><button class="btn" data-no>${esc(t('cancel'))}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`, (dlg, done) => {
      dlg.querySelector('[data-yes]').onclick = () => { answered = true; done(); resolve(true); };
      dlg.querySelector('[data-no]').onclick = () => { answered = true; done(); resolve(false); };
      dlg.addEventListener('close', () => { if (!answered) resolve(false); });
    });
    return close;
  });
}

// Tracks object URLs created for the current view so they can be freed on navigation.
const urls = [];
export function objectUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}
export function revokeUrls() {
  while (urls.length) URL.revokeObjectURL(urls.pop());
}
