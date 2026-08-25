import InvitationAcceptPage from "./screen";

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InvitationAcceptPage token={token} />;
}
