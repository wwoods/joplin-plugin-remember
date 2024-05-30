export default function(context) {
  return {
    plugin(markdownIt, options) {
      (window as any).markdownIt = markdownIt;
      const oldFence = markdownIt.renderer.rules.fence || function(tokens, idx, options, env, self) {
				return self.renderToken(tokens, idx, options, env, self);
			};

      markdownIt.renderer.rules.fence = function(tokens, idx, options, env, self) {
        let token = tokens[idx];

        if (token.info.split(' ')[0] !== 'remember-review') {
          return oldFence.apply(this, arguments);
        }

        let html = [];
        html.push('<div class="joplin-plugin-remember-remember-review">');

        const data = JSON.parse(token.content.trim());
        for (let i = 0, m = data.context.length; i < m; i++) {
          if (i !== 0) html.push(`<details><summary>More context</summary>`);
          html.push(markdownIt.render(data.context[i]));
          if (i !== 0) html.push('</details>');
        }

        html.push('<details class="answer"><summary>Correct response</summary>');
        for (const o of data.content) {
          html.push(markdownIt.render(o));
        }
        html.push('</details>');

        html.push('<details class="notelink"><summary>Link to note</summary>');
        html.push(`<p><a href="joplin://${data.note.id}">${htmlEscape(data.note.title)}</a></p>`);
        if (data.noteLog) {
          html.push(`<p><a href="joplin://${data.noteLog.id}">(Remember Plugin Database) ${htmlEscape(data.noteLog.title)}</a></p>`);
        }
        html.push('</details>');

        return html.join('');
      };
    },
    assets() {
      // Return CSS files which are required
      return [
        {name: "./block-remember-review.css"},
      ];
    },
  };
};


function htmlEscape(v: string) {
  return (v
      .replace('&', '&amp;')
      .replace('<', '&lt;')
      .replace('>', '&gt;')
      .replace('"', '&quot;')
  );
}

