import { api } from './api.js';
import { onSubmit, toast } from './ui.js';

const requestForm = document.querySelector('#request-form');
const confirmForm = document.querySelector('#confirm-form');
let email = '';

onSubmit(requestForm, async (fd) => {
  email = fd.get('email');
  await api.public.post('/api/v1/auth/password-reset/request', { email });
  // Backend answers 202 even for unknown emails (no account enumeration).
  requestForm.classList.add('hidden');
  confirmForm.classList.remove('hidden');
  confirmForm.querySelector('input')?.focus(); // move keyboard focus into the revealed form
});

onSubmit(confirmForm, async (fd) => {
  await api.public.post('/api/v1/auth/password-reset/confirm', {
    email,
    code: fd.get('code').trim(),
    newPassword: fd.get('newPassword'),
  });
  toast('Password updated — sign in with the new one', 'success');
  setTimeout(() => location.replace('index.html'), 1200);
});
