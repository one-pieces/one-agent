import Link from "next/link";
import ProviderForm from "@/components/ProviderForm";

export const dynamic = "force-dynamic";

/** /providers/new — 新建供应商 */
export default function NewProviderPage() {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0 }}>新建供应商</h2>
        <Link href="/settings/providers" className="muted">
          ← 返回列表
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        填好后保存，Agent 配置里即可用下拉选择它。
      </p>
      <ProviderForm mode="create" />
    </>
  );
}
