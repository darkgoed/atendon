import { MeetRoom } from "@/components/meet-room";

export default async function AuthenticatedMeetPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <MeetRoom endpoint={`/meet/rooms/${encodeURIComponent(roomId)}/token`} />;
}
