import { api } from './api.js';
import { onSubmit, toast } from './ui.js';

const form = document.querySelector('#register-form');

onSubmit(form, async (fd) => {
  if (fd.get('password') !== fd.get('confirm')) {
    form.querySelector('[name="confirm"]').classList.add('input-error');
    toast('Passwords do not match', 'error');
    return;
  }
  const email = fd.get('email');
  await api.public.post('/api/v1/auth/register', {
    email,
    fullname: fd.get('fullname'),
    password: fd.get('password'),
  });
  // 202 Accepted → a verification code was emailed
  location.assign(`verify-email.html?email=${encodeURIComponent(email)}`);
});
