// React hooks that re-render a component when shared Yjs data changes.
// Each one follows the same pattern: read the current value, subscribe to
// changes, unsubscribe on cleanup.

import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

// One key of a Y.Map, e.g. useMapValue<Language>(state, 'language').
export function useMapValue<T>(map: Y.Map<unknown>, key: string): T | undefined {
  const [value, setValue] = useState(() => map.get(key) as T | undefined);
  useEffect(() => {
    const update = () => setValue(map.get(key) as T | undefined);
    update();
    map.observe(update);
    return () => map.unobserve(update);
  }, [map, key]);
  return value;
}

// All items of a Y.Array (used for chat).
export function useArray<T>(array: Y.Array<T>): T[] {
  const [items, setItems] = useState<T[]>(() => array.toArray());
  useEffect(() => {
    const update = () => setItems(array.toArray());
    update();
    array.observe(update);
    return () => array.unobserve(update);
  }, [array]);
  return items;
}

export interface Participant {
  clientId: number;
  name: string;
  color: string;
  role: 'interviewer' | 'candidate';
  isMe: boolean;
}

// Everyone currently connected, from the awareness (presence) protocol.
export function useParticipants(awareness: Awareness): Participant[] {
  const [people, setPeople] = useState<Participant[]>([]);
  useEffect(() => {
    const update = () => {
      const list: Participant[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (state.user) list.push({ ...state.user, clientId, isMe: clientId === awareness.clientID });
      });
      setPeople(list.sort((a, b) => a.clientId - b.clientId));
    };
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [awareness]);
  return people;
}
