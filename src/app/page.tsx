import Link from 'next/link';

export default function Home() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">视频生成 API 调试器</h1>
        <p className="page-description">
          即梦/Seedance 视频生成 API 调试工具，用于快速测试和验证视频生成功能。
        </p>
      </div>

      <div className="card">
        <h2 className="section-title">快速开始</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">步骤 1</span>
            <span className="info-value">
              <Link href="/config" className="table-link">检查 API 配置</Link>
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">步骤 2</span>
            <span className="info-value">
              <Link href="/generate" className="table-link">创建视频任务</Link>
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">步骤 3</span>
            <span className="info-value">
              <Link href="/tasks" className="table-link">查看任务状态</Link>
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">功能说明</h2>
        <ul style={{ paddingLeft: '20px', lineHeight: 2 }}>
          <li>支持文本生成视频和图片生成视频两种模式</li>
          <li>支持 16:9、9:16、1:1 多种比例</li>
          <li>自动保存所有请求和响应 JSON</li>
          <li>支持任务状态轮询</li>
          <li>API Key 仅保存在后端环境变量中</li>
        </ul>
      </div>

      <div className="card">
        <h2 className="section-title">状态说明</h2>
        <div className="info-grid">
          <div>
            <span className="status-badge status-submitted">已提交</span> - 任务已提交到 Provider
          </div>
          <div>
            <span className="status-badge status-running">生成中</span> - 视频正在生成
          </div>
          <div>
            <span className="status-badge status-succeeded">已完成</span> - 视频生成成功
          </div>
          <div>
            <span className="status-badge status-failed">失败</span> - 生成失败，可查看错误信息
          </div>
        </div>
      </div>
    </div>
  );
}
