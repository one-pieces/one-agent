import { redirect } from "next/navigation";

/** 旧地址：/providers/[id] → /settings/providers/[id] */
export default async function LegacyEditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/settings/providers/${id}`);
}
