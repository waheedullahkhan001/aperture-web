import { api, requireAuth } from './api.js';
import { toast, onSubmit, showApiError } from './ui.js';
import './nav.js';

requireAuth();

const form = document.querySelector('#alert-form');

async function load() {
  try {
    const config = await api.get('/api/v1/me/alert-config');
    form.elements.countdownDurationSeconds.value = config.countdownDurationSeconds;
    form.elements.messageTemplate.value = config.messageTemplate;
  } catch (err) {
    form.inert = true; // never let a half-loaded form overwrite the real config
    showApiError(err);
  }
}

onSubmit(form, async (fd) => {
  await api.put('/api/v1/me/alert-config', {
    countdownDurationSeconds: Number(fd.get('countdownDurationSeconds')),
    messageTemplate: fd.get('messageTemplate'),
  });
  toast('Alert settings saved', 'success');
});

load();
