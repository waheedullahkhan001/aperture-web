import { api } from './api.js';
import { onSubmit, toast, showApiError } from './ui.js';

const form = document.querySelector('#verify-form');
const emailInput = form.querySelector('[name="email"]');
const resendBtn = document.querySelector('#resend');

// Pre-fill email when arriving from register/login.
const fromQuery = new URLSearchParams(location.search).get('email');
if (fromQuery) emailInput.value = fromQuery;

onSubmit(form, async (fd) => {
  await api.public.post('/api/v1/auth/verify-email', {
    email: fd.get('email'),
    code: fd.get('code').trim(),
  });
  toast('Email verified — you can sign in now', 'success');
  setTimeout(() => location.replace('index.html'), 1200);
});

// Resend with a 30 s cooldown so the backend's rate limit isn't hammered.
resendBtn.addEventListener('click', async () => {
  if (!emailInput.value) { toast('Enter your email first', 'warning'); return; }
  resendBtn.setAttribute('disabled', '');
  try {
    await api.public.post('/api/v1/auth/resend-verification', { email: emailInput.value });
    toast('A new code was sent', 'success');
  } catch (err) {
    showApiError(err);
  }
  let left = 30;
  const original = resendBtn.textContent;
  const timer = setInterval(() => {
    resendBtn.textContent = `Resend code (${left--}s)`;
    if (left < 0) {
      clearInterval(timer);
      resendBtn.textContent = original;
      resendBtn.removeAttribute('disabled');
    }
  }, 1000);
});
