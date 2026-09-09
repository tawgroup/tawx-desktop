import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ExtractedPdfText {
  text: string;
  truncated: boolean;
}

/** Extract selectable text without rendering pages, stopping once the context budget is full. */
export async function extractPdfText(file: File, maxCharacters: number): Promise<ExtractedPdfText> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({ data: bytes, stopAtErrors: true });

  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    let length = 0;
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      if (!pageText) continue;
      const separator = pages.length ? '\n\n' : '';
      const remaining = maxCharacters - length - separator.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      pages.push(`${separator}${pageText.slice(0, remaining)}`);
      length += separator.length + Math.min(pageText.length, remaining);
      if (pageText.length > remaining || (pageNumber < document.numPages && length >= maxCharacters)) {
        truncated = true;
        break;
      }
    }

    const text = pages.join('');
    if (!text.trim()) {
      throw new Error('This PDF has no readable text. Scanned or image-only PDFs are not supported.');
    }
    return { text, truncated };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : '';
    if (name === 'PasswordException' || /password/i.test(message)) {
      throw new Error('Encrypted or password-protected PDFs are not supported.');
    }
    if (/no readable text/i.test(message)) throw error;
    throw new Error('This PDF could not be read. Use an unencrypted, valid PDF with selectable text.');
  } finally {
    await loadingTask.destroy();
  }
}
