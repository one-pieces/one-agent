import SettingsSubNav from "@/components/SettingsSubNav";

export const dynamic = "force-dynamic";

/** 设置外壳：左侧二级导航（供应商 / 日志）+ 右侧内容 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page">
      <h1>设置</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        模型供应商与请求日志。原来的入口已从左侧导航收进这里。
      </p>
      <div className="agent-split">
        <SettingsSubNav />
        <div className="agent-split-body">{children}</div>
      </div>
    </div>
  );
}
