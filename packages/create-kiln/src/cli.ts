#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import consola from 'consola';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  packageJson,
  tsconfigJson,
  kilnConfig,
  layout,
  indexPage,
  healthApi,
  migrationSql,
  mainRunner,
  gitignore,
  readme,
} from './templates.js';

const main = defineCommand({
  meta: {
    name: 'create-kiln',
    version: '0.1.0',
    description: 'Scaffolding utility for Kiln apps',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'Directory to scaffold the app into',
      required: false,
    },
  },
  async run({ args }) {
    const targetDirName = args.dir || 'kiln-app';
    const targetDir = path.resolve(process.cwd(), targetDirName);

    try {
      const existing = await fs.readdir(targetDir).catch((err: any) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });
      if (existing.length > 0) {
        consola.error(`Directory "${targetDirName}" already exists and is not empty. Choose a different name or empty it first.`);
        process.exit(1);
      }
    } catch (err: any) {
      consola.error(`Failed to check target directory: ${err.message}`);
      process.exit(1);
    }

    consola.info(`Scaffolding new Kiln app in ${targetDir}...`);

    try {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.mkdir(path.join(targetDir, 'pages'), { recursive: true });
      await fs.mkdir(path.join(targetDir, 'api'), { recursive: true });
      await fs.mkdir(path.join(targetDir, 'migrations'), { recursive: true });
      await fs.mkdir(path.join(targetDir, 'src'), { recursive: true });

      // Write files
      await fs.writeFile(path.join(targetDir, 'package.json'), packageJson(targetDirName));
      await fs.writeFile(path.join(targetDir, 'tsconfig.json'), tsconfigJson);
      await fs.writeFile(path.join(targetDir, 'kiln.config.ts'), kilnConfig);
      await fs.writeFile(path.join(targetDir, 'pages/_layout.tsx'), layout);
      await fs.writeFile(path.join(targetDir, 'pages/index.tsx'), indexPage);
      await fs.writeFile(path.join(targetDir, 'api/health.ts'), healthApi);
      await fs.writeFile(path.join(targetDir, 'migrations/0000_init.sql'), migrationSql);
      await fs.writeFile(path.join(targetDir, 'src/main.ts'), mainRunner);
      await fs.writeFile(path.join(targetDir, '.gitignore'), gitignore);
      await fs.writeFile(path.join(targetDir, 'README.md'), readme(targetDirName));

      consola.success(`Successfully scaffolded Kiln app inside ${targetDirName}!`);
      consola.box({
        title: 'Next steps:',
        style: {
          padding: 1,
          borderColor: 'green',
          borderStyle: 'double',
        },
        text: `cd ${targetDirName}\npnpm install\npnpm run dev`,
      });
    } catch (err: any) {
      consola.error(`Failed to scaffold app: ${err.message}`);
      process.exit(1);
    }
  },
});

runMain(main);
