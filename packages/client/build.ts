import { join } from 'path';

const dir = import.meta.dir;
const src = join(dir, 'src/silcrow.js');
const distDir = join(dir, 'dist');

// Copy source as-is (dev/debug build)
await Bun.write(join(distDir, 'silcrow.js'), Bun.file(src));

// Minified build
const result = await Bun.build({
  entrypoints: [src],
  outdir: distDir,
  naming: 'silcrow.min.js',
  minify: true,
  target: 'browser',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const minFile = result.outputs[0];
const raw = (minFile.size / 1024).toFixed(1);
const gz = (Bun.gzipSync(Buffer.from(await minFile.arrayBuffer())).length / 1024).toFixed(1);
console.log(`✓ dist/silcrow.js  (${(Bun.file(src).size / 1024).toFixed(1)} KB — source)`);
console.log(`✓ dist/silcrow.min.js  (${raw} KB raw | ${gz} KB gzip)`);

if (process.argv.includes('--watch')) {
  console.log('\nWatching src/silcrow.js…');
  const watcher = Bun.watch(src);
  for await (const _event of watcher) {
    console.log('⟳ changed, rebuilding…');
    await Bun.write(join(distDir, 'silcrow.js'), Bun.file(src));
    await Bun.build({ entrypoints: [src], outdir: distDir, naming: 'silcrow.min.js', minify: true, target: 'browser' });
    console.log('✓ done');
  }
}
