import subsetFont from 'subset-font';
import fs from 'node:fs';

const src = '/workspace/.fonts/NotoSansSC.ttf';
const dst = '/workspace/public/assets/fonts/NotoSansSC-subset.woff2';

// Collect every character the UI can display, plus digits and punctuation.
const files = [ 'index.html', 'src/ui.js', 'src/state.js', 'src/main.js', 'src/renderer.js', 'src/selfcheck.js' ];
let chars = '';
for ( const f of files ) chars += fs.readFileSync( '/workspace/' + f, 'utf8' );
chars += '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
chars += '·×—…“”‘’、。，：；！？（）【】《》%+-⎓';

const text = [ ...new Set( chars.replace( /\s+/g, '' ) ) ].join( '' );
const buffer = fs.readFileSync( src );
const out = await subsetFont( buffer, text, { targetFormat: 'woff2' } );
fs.mkdirSync( '/workspace/public/assets/fonts', { recursive: true } );
fs.writeFileSync( dst, out );
console.log( `subset chars=${text.length} bytes=${out.length}` );
