import { cpSync, rmSync } from 'node:fs';

rmSync('public', { recursive: true, force: true });
cpSync('dist', 'public', { recursive: true });
