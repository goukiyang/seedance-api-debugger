import fs from 'fs';
import path from 'path';
import type PDFDocumentType from 'pdfkit';

const loadPdfDocument = () => {
  const nodeRequire = eval('require') as NodeRequire;
  return nodeRequire('pdfkit') as typeof PDFDocumentType;
};

type FeedbackForPdf = {
  id: string;
  content: string;
  image_urls_json: string | null;
  page_url: string | null;
  pathname: string | null;
  task_id: string | null;
  user_agent?: string | null;
  admin_note: string | null;
  status: string;
  created_at: Date;
  user?: {
    name: string;
    username: string;
    email: string;
  } | null;
};

const CJK_FONT_CANDIDATES = [
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  path.join(process.cwd(), 'public', 'fonts', 'NotoSansCJK-Regular.ttc'),
];

function getChineseFontPath() {
  return CJK_FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

function parseImageUrls(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function statusText(status: string) {
  if (status === 'reviewed') return '已查看';
  if (status === 'archived') return '已归档';
  return '新反馈';
}

function submitterText(feedback: FeedbackForPdf) {
  if (!feedback.user) return '未登录用户';
  return `${feedback.user.name} (${feedback.user.username}, ${feedback.user.email})`;
}

async function imageBufferFromUrl(url: string) {
  if (url.startsWith('/')) {
    const filePath = path.join(process.cwd(), 'public', url.replace(/^\/+/, ''));
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function drawFeedbackBlock(doc: PDFKit.PDFDocument, feedback: FeedbackForPdf, index?: number) {
  if (index !== undefined) {
    doc.fontSize(15).text(`反馈 ${index + 1}`, { underline: true });
    doc.moveDown(0.5);
  }

  doc.fontSize(18).text('Seedance 2.0 Feedback');
  doc.moveDown(0.7);
  doc.fontSize(10);
  doc.text(`反馈 ID：${feedback.id}`);
  doc.text(`提交时间：${feedback.created_at.toLocaleString('zh-CN')}`);
  doc.text(`提交人：${submitterText(feedback)}`);
  doc.text(`页面路径：${feedback.pathname || '-'}`);
  doc.text(`页面 URL：${feedback.page_url || '-'}`);
  doc.text(`任务 ID：${feedback.task_id || '-'}`);
  doc.text(`状态：${statusText(feedback.status)}`);
  doc.moveDown();

  doc.fontSize(12).text('反馈内容', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10).text(feedback.content || '-', { width: 480 });
  doc.moveDown();

  doc.fontSize(12).text('管理员备注', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10).text(feedback.admin_note || '-', { width: 480 });
  doc.moveDown();

  const imageUrls = parseImageUrls(feedback.image_urls_json);
  doc.fontSize(12).text('上传图片', { underline: true });
  doc.moveDown(0.5);
  if (imageUrls.length === 0) {
    doc.fontSize(10).text('无');
  } else {
    for (let imageIndex = 0; imageIndex < imageUrls.length; imageIndex += 1) {
      const url = imageUrls[imageIndex];
      doc.fontSize(9).text(`图片 ${imageIndex + 1}：${url}`, { width: 480 });
      const buffer = await imageBufferFromUrl(url);
      if (buffer) {
        if (doc.y > 620) doc.addPage();
        try {
          doc.image(buffer, { fit: [440, 220] });
          doc.moveDown();
        } catch {
          doc.fontSize(9).text('图片无法嵌入，可通过上方链接查看。');
        }
      } else {
        doc.fontSize(9).text('图片无法读取，可通过上方链接查看。');
      }
      doc.moveDown(0.6);
    }
  }
}

export async function createFeedbackPdf(feedbacks: FeedbackForPdf[]) {
  const PDFDocument = loadPdfDocument();
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const fontPath = getChineseFontPath();
  if (fontPath) {
    doc.font(fontPath);
  }

  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

  for (let index = 0; index < feedbacks.length; index += 1) {
    const feedback = feedbacks[index];
    if (index > 0) doc.addPage();
    await drawFeedbackBlock(doc, feedback, feedbacks.length > 1 ? index : undefined);
  }

  doc.end();
  await new Promise<void>((resolve) => doc.on('end', resolve));
  return Buffer.concat(chunks);
}
