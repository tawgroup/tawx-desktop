import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAttachment,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_FILE_BYTES,
  truncateAttachmentText,
  validateAttachment,
} from '../src/lib/attachments.ts';

const file = (name: string, type: string, size = 128) => ({ name, type, size });

test('classifyAttachment accepts provider-supported images and normalizes missing MIME types', () => {
  assert.deepEqual(classifyAttachment(file('photo.JPG', '')), {
    kind: 'image',
    mimeType: 'image/jpeg',
    pdf: false,
  });
  assert.deepEqual(classifyAttachment(file('paste.png', 'image/png')), {
    kind: 'image',
    mimeType: 'image/png',
    pdf: false,
  });
});

test('classifyAttachment recognizes readable source and PDF files but rejects binary files', () => {
  assert.deepEqual(classifyAttachment(file('main.ts', '')), {
    kind: 'text',
    mimeType: 'text/plain',
    pdf: false,
  });
  assert.deepEqual(classifyAttachment(file('requirements.pdf', 'application/octet-stream')), {
    kind: 'text',
    mimeType: 'application/pdf',
    pdf: true,
  });
  assert.equal(classifyAttachment(file('archive.zip', 'application/zip')), null);
  assert.equal(classifyAttachment(file('disguised.txt', 'application/zip')), null);
});

test('validateAttachment applies kind-specific size limits and rejects empty files', () => {
  const image = classifyAttachment(file('photo.png', 'image/png'));
  const text = classifyAttachment(file('notes.txt', 'text/plain'));
  const pdf = classifyAttachment(file('notes.pdf', 'application/pdf'));

  assert.equal(validateAttachment(file('photo.png', 'image/png', MAX_IMAGE_BYTES), image), null);
  assert.match(validateAttachment(file('photo.png', 'image/png', MAX_IMAGE_BYTES + 1), image) ?? '', /too large/);
  assert.match(validateAttachment(file('notes.txt', 'text/plain', MAX_TEXT_FILE_BYTES + 1), text) ?? '', /maximum 1 MB/);
  assert.match(validateAttachment(file('notes.pdf', 'application/pdf', MAX_PDF_BYTES + 1), pdf) ?? '', /maximum 10 MB/);
  assert.match(validateAttachment(file('empty.txt', 'text/plain', 0), text) ?? '', /empty files/);
  assert.match(validateAttachment(file('archive.zip', 'application/zip'), null) ?? '', /unsupported file type/);
});

test('truncateAttachmentText reports when readable context was bounded', () => {
  assert.deepEqual(truncateAttachmentText('abcdef', 4), { text: 'abcd', truncated: true });
  assert.deepEqual(truncateAttachmentText('abcd', 4), { text: 'abcd', truncated: false });
});
