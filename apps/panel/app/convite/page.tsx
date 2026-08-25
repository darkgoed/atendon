import InvitationAcceptPage from "../invitations/[token]/screen";

export default async function ConvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <InvitationAcceptPage token={token ?? ""} />;
}
