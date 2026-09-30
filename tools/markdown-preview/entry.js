import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const parser = new Marked({ gfm: true, breaks: false, renderer: {
  // Preview images as their labels; hovering must not initiate external requests.
  image({ text }) { return escape(text || '图片'); },
  html({ text }) { return escape(text); },
} });

window.__wbsMarkdownPreview = {
  render(text) {
    const html = parser.parse(String(text).slice(0, 20000));
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 's', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'input'],
      // Links remain readable without navigating the official renderer.
      ALLOWED_ATTR: ['start', 'align', 'type', 'checked', 'disabled'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
      ...(window.__wbsTrustedHtmlPolicy ? { TRUSTED_TYPES_POLICY: window.__wbsTrustedHtmlPolicy } : {}),
    });
  },
};
