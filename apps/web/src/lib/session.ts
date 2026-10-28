import { api } from './api';

export async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.assign('/login');
}
