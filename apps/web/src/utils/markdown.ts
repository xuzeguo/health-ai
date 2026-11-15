import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, sql, python, xml, css })) {
  hljs.registerLanguage(name, language);
}
const aliases: Record<string, string> = {
  javascript: 'javascript', js: 'javascript', typescript: 'typescript', ts: 'typescript',
  json: 'json', bash: 'bash', sh: 'bash', shell: 'bash', sql: 'sql', python: 'python', py: 'python',
  html: 'xml', xml: 'xml', css: 'css',
};
const markdown = new MarkdownIt({
  html: false, linkify: true, breaks: true,
  highlight(code, language) {
    const canonical = Object.hasOwn(aliases, language) ? aliases[language] : undefined;
    if (!canonical) return ''; // markdown-it escapes unknown/unfinished fences.
    try {
      return `<pre><code class="hljs language-${canonical}">${hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value}</code></pre>`;
    } catch { return ''; }
  },
});
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]!.attrSet('target', '_blank');
  tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

// The renderer is private so callers cannot enable HTML or replace link safety.
export function renderMarkdown(content: string): string {
  return markdown.render(content);
}
