'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';

// Browser-only for the same reason as the room page (Monaco editor).
const Replay = dynamic(() => import('@/components/Replay'), { ssr: false });

export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  return <Replay roomId={id} />;
}
