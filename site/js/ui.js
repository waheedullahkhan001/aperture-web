// Tiny shared page helpers: HTML escaping, toasts, confirm dialog, formatting, forms.

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'); // safe for text AND double-quoted attribute contexts
}

function toastHost() {
  let host = document.querySelector('[data-toasts]');
  if (!host) {
    host = document.createElement('div');
    host.dataset.toasts = '';
    document.body.appendChild(host);
  }
  host.className = 'toast toast-end z-50';
  return host;
}

export function toast(message, type = 'info') { // type: info | success | error | warning
  const el = document.createElement('div');
  el.className = `alert alert-${type}`;
  el.textContent = message;
  toastHost().appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Promise<boolean> confirm dialog using native <dialog> + daisyUI modal classes.
export function confirmDialog(message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <div class="modal-box">
        <p class="py-2">${esc(message)}</p>
        <div class="modal-action">
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn btn-error" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    dialog.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act) { dialog.close(); dialog.remove(); resolve(act === 'ok'); }
    });
    dialog.addEventListener('cancel', () => { dialog.remove(); resolve(false); }); // ESC key
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

export function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Shows an ApiError: highlights invalid fields on the form (if given) and toasts the message.
export function showApiError(err, form = null) {
  if (form && err.fieldErrors?.length) {
    for (const fe of err.fieldErrors) {
      form.querySelector(`[name="${fe.field}"]`)?.classList.add('input-error');
    }
    toast(err.fieldErrors.map((fe) => `${fe.field}: ${fe.message}`).join('; '), 'error');
    return;
  }
  toast(err.message || 'Something went wrong', 'error');
}

// Wires a form: prevents default, disables the submit button while running,
// clears old field highlights, and shows API errors automatically.
export function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    form.querySelectorAll('.input-error').forEach((el) => el.classList.remove('input-error'));
    btn?.setAttribute('disabled', '');
    try {
      await handler(new FormData(form));
    } catch (err) {
      showApiError(err, form);
    } finally {
      btn?.removeAttribute('disabled');
    }
  });
}
