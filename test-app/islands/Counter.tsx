import React, { useState } from 'react';
import { useLiveValue } from '@kiln/react';

/**
 * ADR-014 demo island. Interactive React state (the button) plus a live
 * store-bridge field: `activeUsers` is declared with target: 'store' in the
 * page's load(), so SSE patches reach this component through the Silcrow
 * atom (`live:activeUsers`) — silcrow never touches this DOM subtree.
 */
export default function Counter({ start, label }: { start: number; label: string }) {
  const [count, setCount] = useState(start);
  const activeUsers = useLiveValue<number>('activeUsers', 0);
  return (
    <div style={{ border: '1px solid #999', borderRadius: 6, padding: 12, maxWidth: 360 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{label}</p>
      <button onClick={() => setCount(count + 1)}>clicked {count} times</button>
      <p style={{ fontSize: 12 }}>
        active users (live via store): <strong>{activeUsers}</strong>
      </p>
    </div>
  );
}
