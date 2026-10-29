import { marked } from "marked";
import DOMPurify from "dompurify";

export function render(text) {
  return DOMPurify.sanitize(marked.parse(String(text || ""), { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "video", "audio", "iframe", "form", "input", "button", "style"],
    FORBID_ATTR: ["style", "id", "name"]
  });
}
