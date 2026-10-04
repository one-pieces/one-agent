import { redirect } from "next/navigation";

/** /settings 默认进入供应商（设置下的第一个分节） */
export default function SettingsIndexPage() {
  redirect("/settings/providers");
}
