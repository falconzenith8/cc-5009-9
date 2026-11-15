// Shared preflight for the maintenance tools: the lab UI must be reachable.
// localhost may resolve to ::1 while node-fetch prefers 127.0.0.1 (or the
// reverse), so probe every candidate before giving up with a clear hint.
const CANDIDATES = [ 'http://localhost:4173/', 'http://[::1]:4173/', 'http://127.0.0.1:4173/' ];

export async function ensureServer() {
  for ( const url of CANDIDATES ) {
    try {
      const r = await fetch( url );
      if ( r.ok ) return url;
    } catch { /* try next */ }
  }
  console.error( '界面未启动。请先运行 npm run dev（或 npm run preview），再执行本脚本。' );
  process.exit( 1 );
}
