'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';

// WHY ssr: false: the room needs a WebSocket, localStorage and the Monaco
// editor, none of which exist while Next.js renders on the server.
const Room = dynamic(() => import('@/components/Room'), { ssr: false });

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  return <Room roomId={id} />;
}
