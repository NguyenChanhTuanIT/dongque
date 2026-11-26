// Who is in the room, by character id ('local' = us, otherwise the relay id),
// fed by the mp_* events the character engine emits (engine/characters.ts).
// Players without an account-verified name show as "Người dùng ẩn danh <id>".

import { events } from '../core/events';

const names = new Map<string, string>();
let selfId = '';

events.on('mp_connected', (id: string) => {
  selfId = id;
  events.emit('social_names_changed'); // our guest name depends on the id
});
events.on('mp_disconnected', () => {
  selfId = '';
  names.clear();
  events.emit('social_names_changed');
});
events.on('mp_leave', (id: string) => {
  names.delete(id);
});
events.on('mp_name', (id: string, name: string) => {
  if (name) names.set(id, name);
  else names.delete(id);
  events.emit('social_names_changed');
});

export function isConnected(): boolean {
  return selfId !== '';
}

/** Chosen (account-verified) name, or '' for a guest. */
export function chosenName(charId: string): string {
  return names.get(charId) ?? '';
}

export function displayName(charId: string): string {
  const name = names.get(charId);
  if (name) return name;
  const id = charId === 'local' ? selfId : charId;
  return id ? `Người dùng ẩn danh ${id}` : 'Bạn';
}
