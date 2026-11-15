// Shared headless-browser launcher for the maintenance tools.
//
// Chromium needs system libraries that may be absent on a fresh machine. If
// the repo-local .syslibs/root tree exists (extracted .deb packages, see
// docs/model-assumptions.md §界面启动), it is prepended to LD_LIBRARY_PATH so
// the browser child process can find them without touching the system.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../..' );

const LAUNCH_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox'
];

export async function launchBrowser() {
  const libDirs = [
    path.join( ROOT, '.syslibs/root/usr/lib/aarch64-linux-gnu' ),
    path.join( ROOT, '.syslibs/root/lib/aarch64-linux-gnu' ),
    path.join( ROOT, '.syslibs/root/usr/lib/x86_64-linux-gnu' ),
    path.join( ROOT, '.syslibs/root/lib/x86_64-linux-gnu' )
  ].filter( ( d ) => fs.existsSync( d ) );
  if ( libDirs.length > 0 ) {
    process.env.LD_LIBRARY_PATH =
      [ ...libDirs, process.env.LD_LIBRARY_PATH ].filter( Boolean ).join( ':' );
  }
  return chromium.launch( { args: LAUNCH_ARGS } );
}
