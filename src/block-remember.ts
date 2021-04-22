export default function(context) {
  return {
    plugin(markdownIt, options) {
      (window as any).markdownIt = markdownIt;
      const oldFence = markdownIt.renderer.rules.fence || function(tokens, idx, options, env, self) {
				return self.renderToken(tokens, idx, options, env, self);
			};

      markdownIt.renderer.rules.fence = function(tokens, idx, options, env, self) {
        let token = tokens[idx];

        if (token.info.split(' ')[0] !== 'remember') {
          return oldFence.apply(this, arguments);
        }

        let html = [];
        html.push('<div class="joplin-plugin-remember-remember">');
        html.push('<div class="header">REMEMBER</div><div class="body">');
        if (token.content.trim().length !== 0) {
          html.push(markdownIt.render(token.content));
        }
        html.push('</div></div>');

        return html.join('');
      };
    },
    assets() {
      // Return CSS files which are required
      return [
        {name: "./block-remember.css"},
      ];
    },
  };
};

