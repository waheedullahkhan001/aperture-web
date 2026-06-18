import { api, requireAuth } from './api.js';
import { esc, toast, confirmDialog, onSubmit, showApiError } from './ui.js';
import { icon } from './icons.js';
import './nav.js';

requireAuth();

const rows = document.querySelector('#rows');
const dialog = document.querySelector('#contact-dialog');
const dialogTitle = document.querySelector('#dialog-title');
const form = document.querySelector('#contact-form');
let contacts = [];
let editingId = null; // null = adding, otherwise the contact id being edited

async function load() {
  try {
    contacts = await api.get('/api/v1/me/contacts');
    rows.innerHTML = contacts.length ? contacts.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.email)}</td>
        <td class="max-w-xs truncate">${c.messageOverride ? esc(c.messageOverride) : '<span class="opacity-50">default</span>'}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-sm gap-1" data-edit="${c.id}">${icon('pencil')}Edit</button>
          <button class="btn btn-sm btn-error btn-outline gap-1" data-delete="${c.id}">${icon('trash-2')}Remove</button>
        </td>
      </tr>`).join('')
      : `<tr><td colspan="4" class="p-10"><div class="flex flex-col items-center gap-2 opacity-60">${icon('users', 'size-10')}<span>No emergency contacts yet — alerts cannot be sent until you add one.</span></div></td></tr>`;
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="4" class="text-center p-6 text-error">Failed to load contacts.</td></tr>';
    showApiError(err);
  }
}

function openDialog(contact = null) {
  editingId = contact?.id ?? null;
  dialogTitle.textContent = contact ? 'Edit contact' : 'Add contact';
  form.reset();
  if (contact) {
    form.elements.name.value = contact.name;
    form.elements.email.value = contact.email;
    form.elements.messageOverride.value = contact.messageOverride ?? '';
  }
  dialog.showModal();
}

document.querySelector('#add').addEventListener('click', () => openDialog());

onSubmit(form, async (fd) => {
  const body = {
    name: fd.get('name'),
    email: fd.get('email'),
    messageOverride: fd.get('messageOverride').trim() || null,
  };
  if (editingId == null) await api.post('/api/v1/me/contacts', body);
  else await api.patch(`/api/v1/me/contacts/${editingId}`, body);
  dialog.close();
  toast('Contact saved', 'success');
  load();
});

rows.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const deleteBtn = e.target.closest('[data-delete]');
  if (editBtn) {
    openDialog(contacts.find((c) => String(c.id) === editBtn.dataset.edit));
  } else if (deleteBtn) {
    const id = deleteBtn.dataset.delete;
    const name = contacts.find((c) => String(c.id) === id)?.name ?? 'this contact';
    if (!await confirmDialog(`Remove "${name}" from your emergency contacts?`, 'Remove')) return;
    try {
      await api.del(`/api/v1/me/contacts/${id}`);
      toast('Contact removed', 'success');
      load();
    } catch (err) {
      showApiError(err);
    }
  }
});

document.querySelectorAll('dialog [data-close]').forEach((btn) =>
  btn.addEventListener('click', () => btn.closest('dialog').close()));

// Reset edit state whenever the dialog closes, however it was dismissed.
dialog.addEventListener('close', () => { editingId = null; });

load();
