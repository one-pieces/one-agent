import { redirect } from "next/navigation";

/** 旧地址：新建供应商已收进设置 */
export default function LegacyNewProviderPage() {
  redirect("/settings/providers/new");
}
