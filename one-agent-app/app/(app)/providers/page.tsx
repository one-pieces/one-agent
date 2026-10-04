import { redirect } from "next/navigation";

/** 旧地址：供应商已收进设置（/settings/providers） */
export default function LegacyProvidersPage() {
  redirect("/settings/providers");
}
