import { api, tokens } from './api.js';
import { onSubmit } from './ui.js';

// Already signed in? Go straight to the app.
if (tokens.refresh) location.replace('recordings.html');

onSubmit(document.querySelector('#login-form'), async (fd) => {
  const email = fd.get('email');
  try {
    const result = await api.public.post('/api/v1/auth/login', {
      email,
      password: fd.get('password'),
    });
    tokens.save(result);
    location.replace('recordings.html');
  } catch (err) {
    if (err.code === 'EMAIL_NOT_VERIFIED') {
      // No toast here — navigation would discard it; the verify page explains itself.
      location.assign(`verify-email.html?email=${encodeURIComponent(email)}`);
      return;
    }
    throw err; // onSubmit shows it
  }
});
