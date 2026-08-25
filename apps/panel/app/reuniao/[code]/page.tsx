import { MeetRoom } from "@/components/meet-room";

export default async function PublicMeetPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <MeetRoom endpoint={`/meet/join/${encodeURIComponent(code)}`} publicAccess />;
}
