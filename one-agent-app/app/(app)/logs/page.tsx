import { redirect } from "next/navigation";

/** 旧地址：请求日志已收进设置（/settings/logs） */
export default function LegacyLogsPage() {
  redirect("/settings/logs");
}
