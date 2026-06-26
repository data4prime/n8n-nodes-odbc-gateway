const { src, dest } = require('gulp');

// Copia le icone (svg/png) accanto ai file compilati in dist/nodes.
function buildIcons() {
	return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

exports['build:icons'] = buildIcons;
